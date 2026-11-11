export type RelayChangeStream = {
  on(event: "change" | "error" | "close" | "end", listener: (value?: any) => void): unknown;
  close(): Promise<unknown> | unknown;
};

/** One stream and one unref'ed retry timer at most, including synchronous watch failures. */
export function createRealtimeRelay(options: {
  isConnected: () => boolean;
  open: () => RelayChangeStream;
  onChange: (change: any) => void;
  onError: (error: unknown) => void;
  schedule?: (callback: () => void, delayMs: number) => () => void;
}) {
  const schedule = options.schedule || ((callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  });
  let current: RelayChangeStream | null = null;
  let cancelRetry: (() => void) | null = null;
  let retryMs = 1_000;
  let stopped = true;

  function close(changes: RelayChangeStream) {
    try { void Promise.resolve(changes.close()).catch(() => undefined); }
    catch { /* A broken stream must not prevent scheduling recovery. */ }
  }
  function retry() {
    if (stopped || cancelRetry) return;
    const delay = retryMs;
    retryMs = Math.min(30_000, retryMs * 2);
    cancelRetry = schedule(() => { cancelRetry = null; connect(); }, delay);
  }
  function connect() {
    if (stopped || current) return;
    if (!options.isConnected()) { retry(); return; }
    try {
      const changes = options.open();
      current = changes;
      const failed = (error?: unknown) => {
        // Ignore close/error callbacks from an obsolete stream.
        if (current !== changes) return;
        current = null;
        close(changes);
        if (error) options.onError(error);
        retry();
      };
      changes.on("change", (change) => {
        if (current !== changes) return;
        retryMs = 1_000; // Reset on useful traffic, not on a repeatedly failing open.
        options.onChange(change);
      });
      changes.on("error", failed);
      changes.on("close", () => failed());
      changes.on("end", () => failed());
    } catch (error) {
      const changes = current;
      current = null;
      if (changes) close(changes);
      options.onError(error);
      retry();
    }
  }
  return {
    start() {
      stopped = false;
      if (cancelRetry) { cancelRetry(); cancelRetry = null; }
      connect();
    },
    stop() {
      stopped = true;
      if (cancelRetry) { cancelRetry(); cancelRetry = null; }
      const changes = current;
      current = null;
      if (changes) close(changes);
      retryMs = 1_000;
    },
  };
}

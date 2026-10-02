import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const scannerBinary = String(process.env.CLAMSCAN_PATH || "clamscan");
const scannerTimeoutMs = 20_000;

export type MalwareScanResult = {
  status: "clean";
  engine: "ClamAV";
  signature: null;
};

export class MalwareDetectedError extends Error {
  constructor(message = "MALWARE_DETECTED") {
    super(message);
    this.name = "MalwareDetectedError";
  }
}

export class MalwareScannerUnavailableError extends Error {
  constructor(message = "MALWARE_SCANNER_UNAVAILABLE") {
    super(message);
    this.name = "MalwareScannerUnavailableError";
  }
}

function scannerError(output: string): Error {
  if (/ENOENT|not found|spawn/i.test(output)) return new MalwareScannerUnavailableError();
  return new MalwareScannerUnavailableError("MALWARE_SCANNER_ERROR");
}

async function runScanner(filePath: string): Promise<MalwareScanResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(scannerBinary, ["--no-summary", "--infected", "--stdout", filePath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new MalwareScannerUnavailableError("MALWARE_SCANNER_TIMEOUT")));
    }, scannerTimeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8").slice(0, 4096); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8").slice(0, 4096); });
    child.once("error", (error) => finish(() => reject(scannerError(`${error.message}\n${output}`))));
    child.once("close", (code) => finish(() => {
      if (code === 0) return resolve({ status: "clean", engine: "ClamAV", signature: null });
      if (code === 1) return reject(new MalwareDetectedError());
      return reject(scannerError(output));
    }));
  });
}

export async function scanUploadBuffer(buffer: Buffer, originalName: string): Promise<MalwareScanResult> {
  const directory = await mkdtemp(join(tmpdir(), "piki-upload-"));
  const safeName = `${randomBytes(12).toString("hex")}-${String(originalName || "upload").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120)}`;
  const filePath = join(directory, safeName);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(filePath, buffer, { mode: 0o600 });
    return await runScanner(filePath);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

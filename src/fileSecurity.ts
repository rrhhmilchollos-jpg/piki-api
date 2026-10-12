import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const scannerBinary = String(process.env.CLAMSCAN_PATH || "clamscan");
const scannerTimeoutMs = 20_000;
export const MIN_SCANNER_MEMORY_BYTES = 3 * 1024 ** 3;
export const MAX_DOCUMENT_UPLOAD_BYTES = 2_500_000;
export const DOCUMENT_UPLOAD_MIME_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;
export type DocumentUploadMimeType = typeof DOCUMENT_UPLOAD_MIME_TYPES[number];
export type DocumentUploadInput = Readonly<{
  contentBase64: string;
  sizeBytes: number;
  mimeType: string;
  sha256: string;
}>;
export type NormalizedDocumentUpload = Readonly<{ bytes: Buffer; contentBase64: string }>;
export type MalwareScanResult = { status: "clean"; engine: "ClamAV"; signature: null };
export class MalwareDetectedError extends Error {
  constructor(message = "MALWARE_DETECTED") { super(message); this.name = "MalwareDetectedError"; }
}
export class MalwareScannerUnavailableError extends Error {
  constructor(message = "MALWARE_SCANNER_UNAVAILABLE") { super(message); this.name = "MalwareScannerUnavailableError"; }
}
export class InvalidDocumentUploadError extends Error {
  constructor(public readonly code: "DOCUMENT_BASE64_INVALID" | "DOCUMENT_SIZE_MISMATCH" | "DOCUMENT_SIZE_LIMIT_EXCEEDED" | "DOCUMENT_MIME_TYPE_NOT_ALLOWED" | "DOCUMENT_CONTENT_TYPE_MISMATCH" | "DOCUMENT_CHECKSUM_MISMATCH") {
    super(code);
    this.name = "InvalidDocumentUploadError";
  }
}

function detectedDocumentMime(bytes: Buffer): DocumentUploadMimeType | null {
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  return null;
}

/** Removes control characters and path delimiters before a client filename is stored or passed to a scanner. */
export function sanitizeUploadFileName(originalName: string, fallback = "document"): string {
  const cleaned = String(originalName || "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return cleaned || fallback;
}

/** Keeps the stored filename consistent with the validated PDF-only document policy. */
export function sanitizePdfFileName(originalName: string, fallback = "document.pdf"): string {
  const cleaned = sanitizeUploadFileName(originalName, fallback);
  const stem = cleaned.replace(/\.[^.]*$/, "").trim() || "document";
  return `${stem.slice(0, 176)}.pdf`;
}

/**
 * Canonicalizes a base64 document only after checking its exact decoded size,
 * magic bytes, and checksum. Malware scanning remains a separate fail-closed
 * async step because it depends on ClamAV being available in the runtime.
 */
export function normalizeDocumentUpload(input: DocumentUploadInput): NormalizedDocumentUpload {
  if (!DOCUMENT_UPLOAD_MIME_TYPES.includes(input.mimeType as DocumentUploadMimeType)) throw new InvalidDocumentUploadError("DOCUMENT_MIME_TYPE_NOT_ALLOWED");
  const rawBase64 = String(input.contentBase64 || "").replace(/^data:[^;]+;base64,/i, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(rawBase64) || rawBase64.length % 4 === 1) throw new InvalidDocumentUploadError("DOCUMENT_BASE64_INVALID");
  const bytes = Buffer.from(rawBase64, "base64");
  if (bytes.length !== input.sizeBytes) throw new InvalidDocumentUploadError("DOCUMENT_SIZE_MISMATCH");
  if (bytes.length > MAX_DOCUMENT_UPLOAD_BYTES) throw new InvalidDocumentUploadError("DOCUMENT_SIZE_LIMIT_EXCEEDED");
  if (detectedDocumentMime(bytes) !== input.mimeType) throw new InvalidDocumentUploadError("DOCUMENT_CONTENT_TYPE_MISMATCH");
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== String(input.sha256 || "").toLowerCase()) throw new InvalidDocumentUploadError("DOCUMENT_CHECKSUM_MISMATCH");
  return { bytes, contentBase64: rawBase64 };
}

export function scannerMemorySufficient(limit: number | null): boolean {
  return limit === null || limit >= MIN_SCANNER_MEMORY_BYTES;
}
async function containerMemoryLimit(): Promise<number | null> {
  for (const path of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    try {
      const raw = (await readFile(path, "utf8")).trim();
      if (raw === "max") return null;
      const value = Number(raw);
      if (Number.isFinite(value) && value > 0) return value;
    } catch { /* Otro formato cgroup o sistema sin límite de contenedor. */ }
  }
  return null;
}
export function createScannerQueue(maxPending = 4) {
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;
  return async function queued<T>(work: () => Promise<T>): Promise<T> {
    if (pending >= maxPending) throw new MalwareScannerUnavailableError("MALWARE_SCANNER_BUSY");
    pending += 1;
    const job = tail.catch(() => undefined).then(work);
    tail = job;
    try { return await job; }
    finally { pending -= 1; }
  };
}
const queuedScan = createScannerQueue();
function scannerError(output: string): Error {
  if (/ENOENT|not found|spawn/i.test(output)) return new MalwareScannerUnavailableError();
  return new MalwareScannerUnavailableError("MALWARE_SCANNER_ERROR");
}
async function runScanner(filePath: string): Promise<MalwareScanResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(scannerBinary, ["--no-summary", "--infected", "--stdout", filePath], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let settled = false;
    const finish = (callback: () => void) => { if (settled) return; settled = true; clearTimeout(timeout); callback(); };
    const timeout = setTimeout(() => { child.kill("SIGKILL"); finish(() => reject(new MalwareScannerUnavailableError("MALWARE_SCANNER_TIMEOUT"))); }, scannerTimeoutMs);
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
  const limit = await containerMemoryLimit();
  if (!scannerMemorySufficient(limit)) {
    console.warn(JSON.stringify({ event: "document_scanner_insufficient_memory", limitBytes: limit, requiredBytes: MIN_SCANNER_MEMORY_BYTES }));
    throw new MalwareScannerUnavailableError("MALWARE_SCANNER_INSUFFICIENT_MEMORY");
  }
  return queuedScan(async () => {
    const directory = await mkdtemp(join(tmpdir(), "piki-upload-"));
    const safeName = `${randomBytes(12).toString("hex")}-${String(originalName || "upload").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120)}`;
    const filePath = join(directory, safeName);
    try { await mkdir(directory, { recursive: true }); await writeFile(filePath, buffer, { mode: 0o600 }); return await runScanner(filePath); }
    finally { await rm(directory, { recursive: true, force: true }).catch(() => undefined); }
  });
}

export async function scanUploadBuffers(files: Array<{ buffer: Buffer; originalName: string }>): Promise<MalwareScanResult> {
  const limit = await containerMemoryLimit();
  if (!scannerMemorySufficient(limit)) {
    console.warn(JSON.stringify({ event: "document_scanner_insufficient_memory", limitBytes: limit, requiredBytes: MIN_SCANNER_MEMORY_BYTES }));
    throw new MalwareScannerUnavailableError("MALWARE_SCANNER_INSUFFICIENT_MEMORY");
  }
  return queuedScan(async () => {
    const directory = await mkdtemp(join(tmpdir(), "piki-upload-batch-"));
    try {
      await Promise.all(files.map(async ({ buffer, originalName }, index) => {
        const safeName = `${String(index).padStart(2, "0")}-${randomBytes(12).toString("hex")}-${String(originalName || "upload").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120)}`;
        await writeFile(join(directory, safeName), buffer, { mode: 0o600 });
      }));
      return await runScanner(directory);
    } finally { await rm(directory, { recursive: true, force: true }).catch(() => undefined); }
  });
}

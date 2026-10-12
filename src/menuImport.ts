import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export type ImportedMenuItem = {
  id: string;
  name: string;
  description: string;
  price: number;
  category: string;
  image: string;
  allergens: string[];
  modifiers: [];
  available: boolean;
  vegetarian: boolean;
  popular: boolean;
};

function cleanLine(value: string): string {
  return value.replace(/[\u0000\t]+/g, " ").replace(/\s+/g, " ").replace(/^[•·▪●\-–—]+\s*/, "").trim();
}

function normaliseName(value: string): string {
  return value.toLocaleLowerCase("es-ES").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function categoryLike(line: string): boolean {
  if (line.length < 3 || line.length > 70 || /\d/.test(line)) return false;
  const words = line.split(/\s+/).filter(Boolean);
  return line === line.toLocaleUpperCase("es-ES") || (words.length <= 5 && /:$/.test(line));
}

function ignoredLine(line: string): boolean {
  return !line || /^(carta|menu|menú|página|page|www\.|http|pago|alérgenos|ingredientes|información nutricional)\b/i.test(line);
}

export function parseMenuText(text: string): { items: ImportedMenuItem[]; warnings: string[]; extractedLines: number } {
  const items: ImportedMenuItem[] = [];
  const warnings: string[] = [];
  let category = "General";
  const seen = new Map<string, number>();
  const lines = text.split(/\r?\n/).map(cleanLine).filter((line) => !ignoredLine(line));
  for (const line of lines) {
    if (categoryLike(line)) {
      category = line.replace(/:$/, "").trim().replace(/\b\w/g, (letter) => letter.toLocaleUpperCase("es-ES"));
      continue;
    }
    const match = line.match(/^(.*?)(?:\s+)(\d{1,3}(?:[.,]\d{2}))\s*€?$/);
    if (!match) continue;
    const name = cleanLine(match[1]).replace(/\s*[-–—:]\s*$/, "");
    const price = Number(match[2].replace(",", "."));
    if (name.length < 2 || !Number.isFinite(price) || price < 0 || price > 1000) {
      warnings.push(`Línea no importada: ${line}`);
      continue;
    }
    const key = normaliseName(name);
    if (!key) continue;
    const duplicateNumber = (seen.get(key) || 0) + 1;
    seen.set(key, duplicateNumber);
    const itemName = duplicateNumber > 1 ? `${name} (${duplicateNumber})` : name;
    items.push({
      id: `import-${Date.now().toString(36)}-${items.length + 1}`,
      name: itemName,
      description: "",
      price: Math.round(price * 100) / 100,
      category,
      image: "",
      allergens: [],
      modifiers: [],
      available: true,
      vegetarian: false,
      popular: false,
    });
  }
  if (!items.length) warnings.push("No se han detectado líneas con el formato producto + precio. Añade los productos manualmente o sube una carta con texto seleccionable.");
  if (warnings.length > 20) warnings.splice(20, warnings.length - 20, "Se han omitido más avisos. Revisa el documento original.");
  return { items, warnings, extractedLines: lines.length };
}

async function runTextExtraction(bytes: Buffer, mimeType: string): Promise<{ text: string; method: "pdf-text" | "ocr" }> {
  const directory = await mkdtemp(`${tmpdir()}/piki-menu-`);
  const extension = mimeType === "application/pdf" ? ".pdf" : ".image";
  const input = `${directory}/source${extension}`;
  try {
    await writeFile(input, bytes);
    if (mimeType === "application/pdf") {
      const result = await execFile("pdftotext", ["-layout", input, "-"], { maxBuffer: 2_000_000 });
      return { text: result.stdout, method: "pdf-text" };
    }
    try {
      const result = await execFile("tesseract", [input, "stdout", "-l", "spa+eng"], { maxBuffer: 2_000_000 });
      return { text: result.stdout, method: "ocr" };
    } catch {
      const result = await execFile("tesseract", [input, "stdout", "-l", "eng"], { maxBuffer: 2_000_000 });
      return { text: result.stdout, method: "ocr" };
    }
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function extractAndParseMenu(bytes: Buffer, mimeType: string) {
  const extracted = await runTextExtraction(bytes, mimeType);
  const parsed = parseMenuText(extracted.text);
  return {
    ...parsed,
    extractionMethod: extracted.method,
    textPreview: extracted.text.slice(0, 6000),
  };
}

export function readAssetBytes(contentBase64: string): Buffer {
  return Buffer.from(contentBase64, "base64");
}

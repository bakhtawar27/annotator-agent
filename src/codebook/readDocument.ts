import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";
import {
  getFileExtension,
  isSupportedCodebookFile,
  MAX_CODEBOOK_FILE_BYTES,
  SUPPORTED_CODEBOOK_EXTENSIONS,
} from "./fileTypes";

/**
 * Collapses whitespace that PDF/DOCX extraction tends to produce
 * (e.g. one word per line) while keeping paragraph breaks.
 */
export function cleanExtractedText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Turns an uploaded codebook document into plain text the LLM can read.
 */
export default async function extractCodebookDocumentText({
  fileName,
  buffer,
}: {
  fileName: string;
  buffer: ArrayBuffer;
}): Promise<string> {
  const extension = getFileExtension(fileName);

  if (!isSupportedCodebookFile(fileName)) {
    throw new Error(
      `Unsupported codebook file type "${extension || fileName}". Use one of: ${SUPPORTED_CODEBOOK_EXTENSIONS.join(", ")}`,
    );
  }

  if (buffer.byteLength > MAX_CODEBOOK_FILE_BYTES) {
    throw new Error("Codebook file is larger than 10 MB");
  }

  let text: string;

  if (extension === ".pdf") {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const result = await extractText(pdf, { mergePages: true });
    text = Array.isArray(result.text) ? result.text.join("\n\n") : result.text;
  } else if (extension === ".docx") {
    const result = await mammoth.extractRawText({
      buffer: Buffer.from(buffer),
    });
    text = result.value;
  } else {
    text = new TextDecoder("utf-8").decode(buffer);
  }

  const cleaned = cleanExtractedText(text);
  if (!cleaned) {
    throw new Error(
      "No text could be read from the codebook file. If it is a scanned PDF, export it as text or DOCX first.",
    );
  }

  return cleaned;
}

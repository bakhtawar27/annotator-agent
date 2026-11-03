export const SUPPORTED_CODEBOOK_EXTENSIONS = [
  ".pdf",
  ".docx",
  ".txt",
  ".md",
  ".csv",
  ".json",
] as const;

export const MAX_CODEBOOK_FILE_BYTES = 10 * 1024 * 1024;

export function getFileExtension(fileName: string): string {
  const index = fileName.lastIndexOf(".");
  return index === -1 ? "" : fileName.slice(index).toLowerCase();
}

export function isSupportedCodebookFile(fileName: string): boolean {
  return (SUPPORTED_CODEBOOK_EXTENSIONS as readonly string[]).includes(
    getFileExtension(fileName),
  );
}

import { describe, expect, it } from "vitest";
import extractCodebookDocumentText, {
  cleanExtractedText,
} from "../src/codebook/readDocument";

const toBuffer = (text: string) => new TextEncoder().encode(text).buffer;

describe("cleanExtractedText", () => {
  it("collapses spaces and extra blank lines but keeps paragraphs", () => {
    expect(cleanExtractedText("A  \t code\r\n\r\n\r\n\r\nNext   line ")).toBe(
      "A code\n\nNext line",
    );
  });
});

describe("extractCodebookDocumentText", () => {
  it("reads plain text files", async () => {
    const text = await extractCodebookDocumentText({
      fileName: "codebook.md",
      buffer: toBuffer("# Student input type\n\n- Direct answer"),
    });
    expect(text).toBe("# Student input type\n\n- Direct answer");
  });

  it("rejects unsupported file types", async () => {
    await expect(
      extractCodebookDocumentText({
        fileName: "codebook.png",
        buffer: toBuffer("x"),
      }),
    ).rejects.toThrow(/Unsupported codebook file type/);
  });

  it("rejects files with no text", async () => {
    await expect(
      extractCodebookDocumentText({
        fileName: "codebook.txt",
        buffer: toBuffer("   \n  "),
      }),
    ).rejects.toThrow(/No text could be read/);
  });
});

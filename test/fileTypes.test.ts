import { describe, expect, it } from "vitest";
import {
  getFileExtension,
  isSupportedCodebookFile,
} from "../src/codebook/fileTypes";

describe("codebookFileTypes", () => {
  it("reads the lower-cased extension", () => {
    expect(getFileExtension("STEPS-Final-Codebook.PDF")).toBe(".pdf");
    expect(getFileExtension("codebook")).toBe("");
  });

  it("accepts supported document types only", () => {
    expect(isSupportedCodebookFile("codebook.pdf")).toBe(true);
    expect(isSupportedCodebookFile("codebook.docx")).toBe(true);
    expect(isSupportedCodebookFile("codebook.txt")).toBe(true);
    expect(isSupportedCodebookFile("codebook.csv")).toBe(true);
    expect(isSupportedCodebookFile("codebook.doc")).toBe(false);
    expect(isSupportedCodebookFile("codebook.png")).toBe(false);
  });
});

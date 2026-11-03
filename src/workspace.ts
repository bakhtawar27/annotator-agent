import fse from "node:fs";
import path from "node:path";
import { isSupportedCodebookFile } from "./codebook/fileTypes";

/**
 * Folder layout (default ./workspace, override with AGENT_WORKSPACE):
 *
 *   input/   codebook.pdf, dataset.csv, gold*.csv, column-map.json (you add these)
 *   output/  codebook.json, codebook.md, schema.json
 *            prompts/v1.md, v2.draft.md, ...
 *            runs/v1/annotated.csv, run.json, evaluation.md, evaluation.json,
 *                    disagreements.csv, suggestions.md
 */
export const WORKSPACE = path.resolve(
  process.env.AGENT_WORKSPACE || "workspace",
);
export const INPUT_DIR = path.join(WORKSPACE, "input");
export const OUTPUT_DIR = path.join(WORKSPACE, "output");
export const PROMPTS_DIR = path.join(OUTPUT_DIR, "prompts");
export const RUNS_DIR = path.join(OUTPUT_DIR, "runs");
export const CODEBOOK_JSON = path.join(OUTPUT_DIR, "codebook.json");
export const CODEBOOK_MD = path.join(OUTPUT_DIR, "codebook.md");
export const SCHEMA_JSON = path.join(OUTPUT_DIR, "schema.json");
export const COLUMN_MAP_JSON = path.join(INPUT_DIR, "column-map.json");

export const relative = (filePath: string) =>
  path.relative(process.cwd(), filePath) || ".";

function listInputFiles(): string[] {
  if (!fse.existsSync(INPUT_DIR)) return [];
  return fse
    .readdirSync(INPUT_DIR)
    .filter((name) => !name.startsWith("."))
    .map((name) => path.join(INPUT_DIR, name))
    .filter((filePath) => fse.statSync(filePath).isFile());
}

const isGoldName = (name: string) =>
  /gold|ground|truth|(^|[^a-z])gt([^a-z]|$)|human/i.test(name);

export interface InputFiles {
  codebook: string | null;
  dataset: string | null;
  golds: string[];
  problems: string[];
}

/**
 * Finds the input files: codebook.* / dataset.csv by name, or the only
 * document and the only CSV without "gold" in its name. Every CSV with
 * "gold" (or GT, ground truth, human) in its name is a gold-label file.
 */
export function findInputFiles(overrides: {
  codebook?: string;
  data?: string;
  gold?: string;
}): InputFiles {
  const files = listInputFiles();
  const base = (filePath: string) => path.basename(filePath).toLowerCase();
  const problems: string[] = [];

  const csvs = files.filter((file) => base(file).endsWith(".csv"));
  const documents = files.filter(
    (file) =>
      isSupportedCodebookFile(file) &&
      !base(file).endsWith(".csv") &&
      !base(file).endsWith(".json"),
  );

  const pick = (
    label: string,
    override: string | undefined,
    named: string | undefined,
    candidates: string[],
  ): string | null => {
    if (override) return path.resolve(override);
    if (named) return named;
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      problems.push(
        `Several possible ${label} files in input/ (${candidates.map(base).join(", ")}). Rename one to the standard name or pass --${label === "dataset" ? "data" : label}.`,
      );
    }
    return null;
  };

  return {
    codebook: pick(
      "codebook",
      overrides.codebook,
      files.find((file) => base(file).startsWith("codebook.")),
      documents,
    ),
    dataset: pick(
      "dataset",
      overrides.data,
      files.find((file) => base(file) === "dataset.csv"),
      csvs.filter((file) => !isGoldName(base(file))),
    ),
    golds: overrides.gold
      ? overrides.gold
          .split(",")
          .map((file) => path.resolve(file.trim()))
          .filter(Boolean)
      : csvs.filter((file) => isGoldName(base(file))),
    problems,
  };
}

export function promptFile(version: number, draft = false): string {
  return path.join(PROMPTS_DIR, `v${version}${draft ? ".draft" : ""}.md`);
}

export function runDir(version: number): string {
  return path.join(RUNS_DIR, `v${version}`);
}

/** Accepts "v2", "2" or "V2". */
export function parseVersion(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^v?(\d+)$/i.exec(value.trim());
  return match ? Number(match[1]) : null;
}

function listVersions(dir: string, pattern: RegExp): number[] {
  if (!fse.existsSync(dir)) return [];
  return fse
    .readdirSync(dir)
    .map((name) => pattern.exec(name))
    .filter((match): match is RegExpExecArray => !!match)
    .map((match) => Number(match[1]))
    .sort((a, b) => a - b);
}

export const listPromptVersions = () =>
  listVersions(PROMPTS_DIR, /^v(\d+)\.md$/);
export const listDraftVersions = () =>
  listVersions(PROMPTS_DIR, /^v(\d+)\.draft\.md$/);
export const listRunVersions = () =>
  listVersions(RUNS_DIR, /^v(\d+)$/).filter((version) =>
    fse.existsSync(path.join(runDir(version), "annotated.csv")),
  );

export const latest = (versions: number[]) =>
  versions.length ? versions[versions.length - 1] : null;

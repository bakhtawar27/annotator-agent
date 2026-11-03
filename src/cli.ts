/**
 * Annotator Agent: codebook → prompt → annotations → Cohen's kappa against
 * human labels → suggestions → next prompt version.
 *
 *   ./agent status                  what is there and what to do next
 *   ./agent codebook                read workspace/input/codebook.*
 *   ./agent prompt                  write prompt v1 from the codebook
 *   ./agent annotate [--prompt v1]  run a prompt over the dataset
 *   ./agent evaluate [--run v1]     kappa against the gold-label files
 *   ./agent suggest [--run v1]      suggestions + a draft of the next prompt
 *   ./agent accept v2               make the edited draft prompt v2
 */
import "dotenv/config";
import { parse } from "csv-parse/sync";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import buildAnnotationSchema from "./annotate/responseSchema";
import {
  buildSessionsFromCsvRows,
  type CsvRow,
  type LocalAnnotation,
  type LocalSession,
  mergeAnnotationsIntoRows,
  standardizeTranscriptRows,
  toCsv,
} from "./annotate/transcripts";
import extractCodebookFromDocument from "./codebook/extract";
import generatePromptFromCodebook from "./codebook/generatePrompt";
import type { NormalizedCodebook } from "./codebook/normalize";
import {
  buildAnnotationSchemaFromCategories,
  buildCodebookSummary,
} from "./codebook/summary";
import {
  evaluateAgainstGold,
  type EvaluationReport,
  type GoldFile,
  renderEvaluationMarkdown,
} from "./evaluate/evaluate";
import { chatJson, ConfigError, getModel, usage } from "./llm";
import suggestPromptImprovements, {
  renderSuggestionsMarkdown,
} from "./suggest/suggest";
import type { AnnotationSchemaItem, CodebookCategory } from "./types";
import {
  CODEBOOK_JSON,
  CODEBOOK_MD,
  COLUMN_MAP_JSON,
  findInputFiles,
  INPUT_DIR,
  latest,
  listDraftVersions,
  listPromptVersions,
  listRunVersions,
  OUTPUT_DIR,
  parseVersion,
  promptFile,
  relative,
  runDir,
  SCHEMA_JSON,
  WORKSPACE,
} from "./workspace";

const ANNOTATION_PROMPT_TEMPLATE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "annotate",
  "annotatePerUtterance.prompt.md",
);

type Options = {
  codebook?: string;
  data?: string;
  gold?: string;
  prompt?: string;
  run?: string;
  sessions?: string;
  model?: string;
  concurrency?: string;
  yes?: boolean;
  force?: boolean;
  "exact-labels"?: boolean;
};

class UserError extends Error {}

// ---------- file helpers ----------

const exists = (filePath: string) => fs.existsSync(filePath);

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fsp.readFile(filePath, "utf-8")) as T;
}

async function writeFile(filePath: string, content: string) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, content);
}

const writeJson = (filePath: string, value: unknown) =>
  writeFile(filePath, JSON.stringify(value, null, 2) + "\n");

function readFileAsArrayBuffer(filePath: string): ArrayBuffer {
  const buffer = fs.readFileSync(filePath);
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

async function readCsv(filePath: string): Promise<CsvRow[]> {
  return parse(await fsp.readFile(filePath, "utf-8"), {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    relax_column_count: true,
  }) as CsvRow[];
}

async function readGoldFiles(paths: string[]): Promise<GoldFile[]> {
  return Promise.all(
    paths.map(async (filePath) => ({
      name: path.basename(filePath),
      rows: await readCsv(filePath),
    })),
  );
}

async function confirm(question: string, yes?: boolean): Promise<boolean> {
  if (yes) return true;
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await readline.question(`${question} [y/N] `);
  readline.close();
  return answer.trim().toLowerCase().startsWith("y");
}

// ---------- codebook helpers ----------

async function loadCodebook(): Promise<NormalizedCodebook> {
  if (!exists(CODEBOOK_JSON)) {
    throw new UserError("No codebook yet. Run: ./agent codebook");
  }
  return readJson<NormalizedCodebook>(CODEBOOK_JSON);
}

function schemaFor(codebook: NormalizedCodebook): AnnotationSchemaItem[] {
  return buildAnnotationSchemaFromCategories(
    codebook.categories as CodebookCategory[],
  );
}

function summaryFor(codebook: NormalizedCodebook): string {
  return buildCodebookSummary({
    codebookName: codebook.name,
    codebookDescription: codebook.intention,
    categories: codebook.categories as CodebookCategory[],
  });
}

function codebookToMarkdown(codebook: NormalizedCodebook): string {
  const lines = [`# ${codebook.name}`, "", codebook.intention, ""];
  for (const category of codebook.categories) {
    lines.push(`## ${category.name}`, "", category.description, "");
    for (const code of category.codes) {
      lines.push(`- **${code.code}**: ${code.definition}`);
      for (const example of code.examples) {
        lines.push(`  - ${example.exampleType}: "${example.example}"`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

function resolveVersion(
  value: string | undefined,
  versions: number[],
  label: string,
  hint: string,
): number {
  if (value) {
    const version = parseVersion(value);
    if (version === null || !versions.includes(version)) {
      throw new UserError(
        `${label} ${value} not found. Available: ${versions.map((v) => `v${v}`).join(", ") || "none"}`,
      );
    }
    return version;
  }
  const newest = latest(versions);
  if (newest === null) throw new UserError(hint);
  return newest;
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
) {
  let next = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        await worker(items[index], index);
      }
    },
  );
  await Promise.all(runners);
}

function printUsage() {
  if (usage.calls) {
    console.log(
      `Model calls: ${usage.calls}, tokens in/out: ${usage.inputTokens}/${usage.outputTokens}`,
    );
  }
}

// ---------- commands ----------

async function status(options: Options) {
  const inputs = findInputFiles(options);
  const prompts = listPromptVersions();
  const drafts = listDraftVersions();
  const runs = listRunVersions();

  console.log(`Workspace: ${relative(WORKSPACE)}\n`);
  console.log("Input files:");
  console.log(
    `  codebook  ${inputs.codebook ? relative(inputs.codebook) : "missing"}`,
  );
  console.log(
    `  dataset   ${inputs.dataset ? relative(inputs.dataset) : "missing"}`,
  );
  console.log(
    `  gold      ${inputs.golds.length ? inputs.golds.map(relative).join("\n            ") : "none (optional, needed for evaluate)"}`,
  );
  inputs.problems.forEach((problem) => console.log(`  ! ${problem}`));

  console.log(
    `\nCodebook:  ${exists(CODEBOOK_JSON) ? relative(CODEBOOK_MD) : "not read yet"}`,
  );
  console.log(
    `Prompts:   ${prompts.map((v) => `v${v}`).join(", ") || "none"}${drafts.length ? ` (drafts: ${drafts.map((v) => `v${v}`).join(", ")})` : ""}`,
  );
  console.log("Runs:");
  if (runs.length === 0) console.log("  none");
  for (const version of runs) {
    const evaluationPath = path.join(runDir(version), "evaluation.json");
    if (exists(evaluationPath)) {
      const report = await readJson<EvaluationReport>(evaluationPath);
      console.log(
        `  v${version}: ${report.fields.map((f) => `${f.fieldKey} ${f.kappa}`).join(", ")}`,
      );
    } else {
      console.log(`  v${version}: annotated, not evaluated`);
    }
  }

  let nextStep: string;
  if (!inputs.codebook && !exists(CODEBOOK_JSON))
    nextStep = `Put your codebook in ${relative(INPUT_DIR)}/`;
  else if (!exists(CODEBOOK_JSON)) nextStep = "./agent codebook";
  else if (prompts.length === 0) nextStep = "./agent prompt";
  else if (!inputs.dataset && !inputs.golds.length)
    nextStep = `Put your dataset CSV in ${relative(INPUT_DIR)}/`;
  else if (!runs.includes(latest(prompts)!)) nextStep = "./agent annotate";
  else if (!inputs.golds.length)
    nextStep = `Add gold labels (a CSV with "gold" or "GT" in its name) to ${relative(INPUT_DIR)}/, then ./agent evaluate`;
  else if (!exists(path.join(runDir(latest(runs)!), "evaluation.json")))
    nextStep = "./agent evaluate";
  else if (drafts.length)
    nextStep = `Edit ${relative(promptFile(latest(drafts)!, true))}, then ./agent accept v${latest(drafts)}`;
  else nextStep = "./agent suggest";
  console.log(`\nNext: ${nextStep}`);
}

async function codebookCommand(options: Options) {
  const inputs = findInputFiles(options);
  if (!inputs.codebook) {
    throw new UserError(
      inputs.problems[0] ??
        `No codebook found. Put a PDF, DOCX, TXT or MD codebook in ${relative(INPUT_DIR)}/ (e.g. codebook.pdf).`,
    );
  }
  if (exists(CODEBOOK_JSON) && !options.force) {
    const replace = await confirm(
      `${relative(CODEBOOK_JSON)} exists (maybe with your edits). Replace it?`,
      options.yes,
    );
    if (!replace) return;
  }

  console.log(
    `Reading ${relative(inputs.codebook)} with ${getModel("codebook")} (about a minute)...`,
  );
  const codebook = await extractCodebookFromDocument({
    fileName: path.basename(inputs.codebook),
    buffer: readFileAsArrayBuffer(inputs.codebook),
  });

  await writeJson(CODEBOOK_JSON, codebook);
  await writeFile(CODEBOOK_MD, codebookToMarkdown(codebook));
  const codeCount = codebook.categories.reduce(
    (n, c) => n + c.codes.length,
    0,
  );
  console.log(
    `Found ${codebook.categories.length} categories and ${codeCount} codes.`,
  );
  console.log(`Review: ${relative(CODEBOOK_MD)}`);
  console.log(`Fix mistakes in ${relative(CODEBOOK_JSON)}, then: ./agent prompt`);
  printUsage();
}

async function promptCommand(options: Options) {
  const codebook = await loadCodebook();
  const versions = listPromptVersions();
  if (versions.length && !options.force) {
    throw new UserError(
      `Prompt v${latest(versions)} already exists. Improve it with: ./agent suggest. To write a fresh prompt from the codebook as a new version, use: ./agent prompt --force`,
    );
  }
  const version = (latest(versions) ?? 0) + 1;

  console.log(
    `Writing the annotation prompt with ${getModel("prompt")}...`,
  );
  const promptText = await generatePromptFromCodebook(summaryFor(codebook));

  await writeFile(promptFile(version), promptText);
  await writeJson(SCHEMA_JSON, schemaFor(codebook));
  console.log(`Prompt v${version}: ${relative(promptFile(version))}`);
  console.log("Review or edit it, then: ./agent annotate");
  printUsage();
}

async function selectRowsToAnnotate(
  options: Options,
  inputs: ReturnType<typeof findInputFiles>,
): Promise<{ rows: CsvRow[]; maxSessions: number; source: string }> {
  const sessionsOption =
    options.sessions ?? (inputs.golds.length ? "gold" : "5");
  const datasetRows = inputs.dataset
    ? standardizeTranscriptRows(await readCsv(inputs.dataset))
    : [];

  if (sessionsOption !== "gold") {
    if (!inputs.dataset) {
      throw new UserError(
        inputs.problems[0] ??
          `No dataset found. Put your CSV in ${relative(INPUT_DIR)}/ as dataset.csv.`,
      );
    }
    if (sessionsOption === "all") {
      return { rows: datasetRows, maxSessions: Number.MAX_SAFE_INTEGER, source: "dataset" };
    }
    const maxSessions = Number(sessionsOption);
    if (!Number.isInteger(maxSessions) || maxSessions < 1) {
      throw new UserError('--sessions must be "gold", "all" or a number.');
    }
    return { rows: datasetRows, maxSessions, source: "dataset" };
  }

  if (!inputs.golds.length) {
    throw new UserError("--sessions gold needs a gold-label file in input/.");
  }
  const goldRows = (await readGoldFiles(inputs.golds)).flatMap((file) =>
    standardizeTranscriptRows(file.rows).map((row) => ({
      session_id: row.session_id,
      sequence_id: row.sequence_id,
      role: row.role,
      content: row.content,
    })),
  );
  const goldSessionIds = new Set(goldRows.map((row) => row.session_id));
  const fromDataset = datasetRows.filter((row) =>
    goldSessionIds.has(row.session_id),
  );
  const foundIds = new Set(fromDataset.map((row) => row.session_id));
  const fromGold = goldRows.filter((row) => !foundIds.has(row.session_id));
  if (fromGold.length) {
    const missing = new Set(fromGold.map((row) => row.session_id)).size;
    console.log(
      `${missing} gold sessions are not in the dataset, so their transcripts are taken from the gold files. The model only sees speaker and text, never the human labels.`,
    );
  }
  return {
    rows: [...fromDataset, ...fromGold],
    maxSessions: Number.MAX_SAFE_INTEGER,
    source: "gold sessions",
  };
}

async function annotateCommand(options: Options) {
  const codebook = await loadCodebook();
  const version = resolveVersion(
    options.prompt,
    listPromptVersions(),
    "Prompt",
    "No prompt yet. Run: ./agent prompt",
  );
  const inputs = findInputFiles(options);
  const model = options.model || getModel("annotation");
  const promptPath = promptFile(version);
  if (fs.statSync(CODEBOOK_JSON).mtimeMs > fs.statSync(promptPath).mtimeMs) {
    console.warn(
      `Note: codebook.json changed after prompt v${version} was written. Codes come from the current codebook.`,
    );
  }

  const { rows, maxSessions, source } = await selectRowsToAnnotate(
    options,
    inputs,
  );
  const sessions = buildSessionsFromCsvRows(rows, { maxSessions });
  if (sessions.length === 0) throw new UserError("No sessions to annotate.");
  const utteranceCount = sessions.reduce((n, s) => n + s.transcript.length, 0);
  const outDir = runDir(version);
  const outPath = path.join(outDir, "annotated.csv");

  const replacing = exists(outPath) ? ` This replaces ${relative(outPath)}.` : "";
  const go = await confirm(
    `Annotate ${sessions.length} sessions (${utteranceCount} utterances, ${source}) with prompt v${version} and ${model}?${replacing}`,
    options.yes,
  );
  if (!go) {
    console.log("Stopped. Nothing was sent to the model.");
    return;
  }

  const promptText = await fsp.readFile(promptPath, "utf-8");
  const template = await fsp.readFile(ANNOTATION_PROMPT_TEMPLATE, "utf-8");
  const schemaItems = schemaFor(codebook);
  const exampleAnnotation: Record<string, string> = {};
  for (const item of schemaItems)
    exampleAnnotation[item.fieldKey] = String(item.value ?? "");
  const promptSchema = { annotations: [exampleAnnotation] };
  const responseSchema = buildAnnotationSchema(promptSchema, schemaItems);
  const fieldKeys = schemaItems
    .filter((item) => !item.isSystem)
    .map((item) => item.fieldKey);

  const results: CsvRow[][] = new Array(sessions.length);
  const failed: string[] = [];
  let done = 0;

  await runWithConcurrency(
    sessions,
    Math.max(1, Number(options.concurrency) || 3),
    async (session: LocalSession, index) => {
      try {
        const system = template
          .replaceAll("{{annotationSchema}}", JSON.stringify(promptSchema))
          .replaceAll("{{leadRole}}", session.leadRole);
        const response = await chatJson<{ annotations?: LocalAnnotation[] }>({
          model,
          system,
          user: `${promptText}\n\nConversation: ${JSON.stringify({ transcript: session.transcript, leadRole: session.leadRole })}`,
          schema: responseSchema,
        });
        results[index] = mergeAnnotationsIntoRows(
          session,
          response.annotations ?? [],
          fieldKeys,
        );
      } catch (error) {
        failed.push(session.sessionId);
        results[index] = mergeAnnotationsIntoRows(session, [], fieldKeys);
        console.warn(
          `  session ${session.sessionId} failed: ${error instanceof Error ? error.message : error}`,
        );
      }
      done++;
      console.log(`  ${done}/${sessions.length} sessions`);
    },
  );

  await writeFile(outPath, toCsv(results.flat()));
  await writeJson(path.join(outDir, "run.json"), {
    promptVersion: `v${version}`,
    model,
    source,
    sessions: sessions.length,
    utterances: utteranceCount,
    failedSessions: failed,
    usage,
    createdAt: new Date().toISOString(),
  });
  console.log(`\nAnnotated: ${relative(outPath)}`);
  if (failed.length)
    console.log(
      `${failed.length} sessions failed and have empty AI columns: ${failed.join(", ")}. Run annotate again to retry.`,
    );
  printUsage();
  console.log(
    inputs.golds.length
      ? "Next: ./agent evaluate"
      : `Next: add gold labels to ${relative(INPUT_DIR)}/, then ./agent evaluate`,
  );
}

async function evaluateCommand(options: Options) {
  const codebook = await loadCodebook();
  const version = resolveVersion(
    options.run,
    listRunVersions(),
    "Run",
    "No annotation run yet. Run: ./agent annotate",
  );
  const inputs = findInputFiles(options);
  if (!inputs.golds.length) {
    throw new UserError(
      inputs.problems[0] ??
        `No gold labels found. Put them in ${relative(INPUT_DIR)}/ with "gold" or "GT" in the file name (e.g. gold.csv).`,
    );
  }

  const outDir = runDir(version);
  const aiRows = await readCsv(path.join(outDir, "annotated.csv"));
  const goldFiles = await readGoldFiles(inputs.golds);
  const schemaItems = schemaFor(codebook);
  const fieldKeys = schemaItems
    .filter((item) => !item.isSystem)
    .map((item) => item.fieldKey);
  const codesByField = Object.fromEntries(
    schemaItems
      .filter((item) => !item.isSystem)
      .map((item) => [item.fieldKey, item.codes ?? []]),
  );
  const overrides = exists(COLUMN_MAP_JSON)
    ? await readJson<Record<string, string>>(COLUMN_MAP_JSON)
    : {};

  const report = evaluateAgainstGold({
    aiRows,
    goldFiles,
    fieldKeys,
    codesByField,
    overrides,
    exactLabels: !!options["exact-labels"],
  });
  if (report.matchedRows === 0) {
    throw new UserError(
      `No gold rows matched run v${version}. Annotate the gold sessions first (./agent annotate --prompt v${version} --sessions gold).`,
    );
  }

  await writeJson(path.join(outDir, "evaluation.json"), report);
  await writeFile(
    path.join(outDir, "evaluation.md"),
    renderEvaluationMarkdown(report, `Prompt v${version} vs gold labels`),
  );
  await writeFile(
    path.join(outDir, "disagreements.csv"),
    toCsv(
      report.fields.flatMap((field) =>
        field.disagreements.map((d) => ({
          field: field.fieldKey,
          session_id: d.sessionId,
          sequence_id: d.sequence,
          role: d.role,
          content: d.content,
          gold: d.gold,
          ai: d.ai,
          ai_reasoning: d.reasoning,
        })),
      ),
    ),
  );

  console.log(
    `Gold files: ${report.goldFiles.map((file) => `${file.name} (${file.rows} rows)`).join(", ")}`,
  );
  console.log(
    `Matched ${report.matchedRows} of ${report.goldRows} gold rows.\n`,
  );
  console.table(
    report.fields.map((f) => ({
      field: f.fieldKey,
      kappa: f.kappa,
      level: f.interpretation,
      agreement: `${Math.round(f.agreement * 100)}%`,
      "kappa (non-NA)": f.applicableKappa,
      ...(f.baselineKappa !== null ? { "previous AI kappa": f.baselineKappa } : {}),
    })),
  );
  const mappedLabels = report.fields.reduce(
    (n, f) => n + f.labelMappings.reduce((m, x) => m + x.count, 0),
    0,
  );
  if (mappedLabels) {
    console.log(
      `${mappedLabels} human labels were spelled differently from the codebook and were read as the closest code (listed in evaluation.md). Use --exact-labels to turn this off.`,
    );
  }
  if (report.unmatchedFields.length) {
    console.log(
      `Not evaluated (no human-label column found): ${report.unmatchedFields.join(", ")}. Map them in ${relative(COLUMN_MAP_JSON)}, e.g. {"answer leak (Human)": "TUTOR_ANSWER_LEAK"}.`,
    );
  }
  console.log(`\nReport: ${relative(path.join(outDir, "evaluation.md"))}`);
  console.log(
    `Disagreements: ${relative(path.join(outDir, "disagreements.csv"))}`,
  );
  console.log("Next: ./agent suggest");
}

async function suggestCommand(options: Options) {
  const codebook = await loadCodebook();
  const version = resolveVersion(
    options.run,
    listRunVersions(),
    "Run",
    "No annotation run yet. Run: ./agent annotate",
  );
  const outDir = runDir(version);
  const evaluationPath = path.join(outDir, "evaluation.json");
  if (!exists(evaluationPath)) {
    throw new UserError(
      `Run v${version} is not evaluated yet. Run: ./agent evaluate --run v${version}`,
    );
  }
  const report = await readJson<EvaluationReport>(evaluationPath);
  const promptText = await fsp.readFile(promptFile(version), "utf-8");
  const nextVersion = (latest(listPromptVersions()) ?? version) + 1;
  const draftPath = promptFile(nextVersion, true);

  console.log(
    `Reading the disagreements for prompt v${version} with ${getModel("suggestion")} and drafting v${nextVersion}...`,
  );
  const result = await suggestPromptImprovements({
    promptText,
    codebookSummary: summaryFor(codebook),
    fields: report.fields,
  });

  await writeFile(draftPath, result.revisedPrompt || promptText);
  const suggestionsPath = path.join(outDir, "suggestions.md");
  await writeFile(
    suggestionsPath,
    renderSuggestionsMarkdown(result, {
      fromVersion: `v${version}`,
      draftFile: relative(draftPath),
      nextVersion: `v${nextVersion}`,
    }),
  );

  console.log(`\n${result.summary}\n`);
  console.log(`Suggestions: ${relative(suggestionsPath)}`);
  console.log(`Draft prompt: ${relative(draftPath)}`);
  console.log(`Edit the draft, then: ./agent accept v${nextVersion}`);
  printUsage();
}

async function acceptCommand(versionArg: string | undefined) {
  const version = parseVersion(versionArg) ?? latest(listDraftVersions());
  if (version === null)
    throw new UserError("No draft to accept. Run: ./agent suggest");
  const draft = promptFile(version, true);
  const final = promptFile(version);
  if (!exists(draft)) throw new UserError(`No draft ${relative(draft)}.`);
  if (exists(final)) throw new UserError(`Prompt v${version} already exists.`);
  await fsp.rename(draft, final);
  console.log(`Prompt v${version}: ${relative(final)}`);
  console.log(
    `Next: ./agent annotate --prompt v${version}, then ./agent evaluate`,
  );
}

// ---------- entry ----------

const HELP = `Annotator Agent

  ./agent status                       what is there and what to do next
  ./agent codebook                     read the codebook in workspace/input/
  ./agent prompt                       write prompt v1 from the codebook
  ./agent annotate [--prompt v1]       run a prompt over the dataset
        --sessions gold|all|<n>        default: the gold sessions, else 5
        --model <name>  --concurrency 3  --yes
  ./agent evaluate [--run v1]          Cohen's kappa against the gold-label files
        --exact-labels                 don't read near-identical human labels as codebook codes
  ./agent suggest [--run v1]           suggestions + a draft of the next prompt
  ./agent accept v2                    make the edited draft prompt v2

  Files can also be given with --codebook, --data and --gold (comma-separated).
  On Windows, use "agent" instead of "./agent".`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      codebook: { type: "string" },
      data: { type: "string" },
      gold: { type: "string" },
      prompt: { type: "string" },
      run: { type: "string" },
      sessions: { type: "string" },
      model: { type: "string" },
      concurrency: { type: "string" },
      yes: { type: "boolean", short: "y" },
      force: { type: "boolean" },
      "exact-labels": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, argument] = positionals;
  const options = values as Options;
  await fsp.mkdir(INPUT_DIR, { recursive: true });
  await fsp.mkdir(OUTPUT_DIR, { recursive: true });

  switch (command) {
    case "status":
      return status(options);
    case "codebook":
      return codebookCommand(options);
    case "prompt":
      return promptCommand(options);
    case "annotate":
      return annotateCommand(options);
    case "evaluate":
      return evaluateCommand(options);
    case "suggest":
      return suggestCommand(options);
    case "accept":
      return acceptCommand(argument);
    default:
      console.log(HELP);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    const known = error instanceof UserError || error instanceof ConfigError;
    console.error(known ? `\n${message}` : `\nError: ${message}`);
    process.exit(1);
  });

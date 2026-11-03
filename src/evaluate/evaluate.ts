import {
  type CsvRow,
  normalizeHeader,
  standardizeTranscriptRows,
} from "../annotate/transcripts";
import calculateCohensKappa from "./cohensKappa";
import getKappaInterpretation from "./kappaInterpretation";
import calculatePRF1 from "./prf1";

export const NA_LABEL = "na";

const NA_VALUES = new Set([
  "",
  "na",
  "n a",
  "nan",
  "none",
  "null",
  "not applicable",
  "-",
]);

const NON_LABEL_COLUMNS = new Set([
  "id",
  "number",
  "session id",
  "session",
  "chat id",
  "conversation id",
  "sequence id",
  "sequence",
  "turn",
  "order",
  "index",
  "role",
  "speaker",
  "sender",
  "message type",
  "author",
  "content",
  "text",
  "message",
  "utterance",
  "start time",
  "end time",
  "created at",
  "timestamp",
  "question",
  "question id",
  "question tags",
  "student",
  "participant id",
  "institution id",
  "course id",
  "message id",
]);

/** A column of earlier model labels, e.g. "Answer leak (AI)" or "tutor_output_type(Claude Opus 4.6)". */
const MODEL_LABEL_MARKER =
  /\((?:[^)]*\b(?:ai|llm|model|gpt|claude|gemini|opus|sonnet|predicted|prediction)\b[^)]*)\)/i;

/** "student_input_type (Human)" → "student input type" */
export const normalizeFieldName = normalizeHeader;

function normalizeSingleLabel(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[-_/]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, "")
    .trim()
    .replace(/\s+/g, " ");
  return NA_VALUES.has(normalized) ? NA_LABEL : normalized;
}

/**
 * Case, spacing, hyphens and NA spellings are ignored when comparing labels.
 * Several labels on one utterance ("A, B" from humans or "A | B" from the AI)
 * become one sorted set ("a + b"), so they match regardless of order.
 */
export function normalizeLabel(value: unknown): string {
  const parts = String(value ?? "")
    .split(/\s*\|\s*|,\s*/)
    .map(normalizeSingleLabel);
  const labels = [...new Set(parts.filter((part) => part !== NA_LABEL))].sort();
  return labels.length ? labels.join(" + ") : NA_LABEL;
}

function tokens(name: string): Set<string> {
  return new Set(normalizeFieldName(name).split(" ").filter(Boolean));
}

function overlapScore(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  if (shared === 0) return 0;
  const isSubset = shared === a.size || shared === b.size;
  if (!isSubset) return 0;
  return shared / new Set([...a, ...b]).size;
}

function matchColumns(
  candidates: string[],
  fieldKeys: string[],
  preset: Record<string, string> = {},
): Record<string, string> {
  const mapping: Record<string, string> = { ...preset };
  const used = new Set(Object.values(mapping));

  for (const fieldKey of fieldKeys) {
    if (mapping[fieldKey]) continue;
    const fieldName = normalizeFieldName(fieldKey);
    const exact = candidates.find(
      (header) => !used.has(header) && normalizeFieldName(header) === fieldName,
    );
    if (exact) {
      mapping[fieldKey] = exact;
      used.add(exact);
    }
  }

  for (const fieldKey of fieldKeys) {
    if (mapping[fieldKey]) continue;
    const fieldTokens = tokens(fieldKey);
    let best: { header: string; score: number } | null = null;
    for (const header of candidates) {
      if (used.has(header)) continue;
      const score = overlapScore(fieldTokens, tokens(header));
      if (score > 0 && (!best || score > best.score)) best = { header, score };
    }
    if (best) {
      mapping[fieldKey] = best.header;
      used.add(best.header);
    }
  }

  return mapping;
}

export interface FieldMapping {
  mapping: Record<string, string>;
  baselineMapping: Record<string, string>;
  unmatchedFields: string[];
  unusedGoldColumns: string[];
}

/**
 * Pairs each AI field (e.g. TUTOR_ANSWER_LEAK) with a human-label column
 * (e.g. "answer leak (Human)"): exact name first, then the closest name where
 * one is contained in the other. Columns of earlier model labels ("... (AI)")
 * are never used as gold; they are kept as a baseline to compare against.
 * `overrides` maps gold column → field key.
 */
export function mapGoldColumnsToFields(
  goldHeaders: string[],
  fieldKeys: string[],
  overrides: Record<string, string> = {},
): FieldMapping {
  const preset: Record<string, string> = {};
  for (const [goldColumn, fieldKey] of Object.entries(overrides)) {
    if (goldHeaders.includes(goldColumn) && fieldKeys.includes(fieldKey)) {
      preset[fieldKey] = goldColumn;
    }
  }

  const labelColumns = goldHeaders.filter(
    (header) =>
      !Object.values(preset).includes(header) &&
      !NON_LABEL_COLUMNS.has(normalizeFieldName(header)) &&
      !header.startsWith("ai_") &&
      !["session_id", "sequence_id", "role", "content"].includes(header),
  );
  const humanColumns = labelColumns.filter(
    (header) => !MODEL_LABEL_MARKER.test(header),
  );
  const modelColumns = labelColumns.filter((header) =>
    MODEL_LABEL_MARKER.test(header),
  );

  const mapping = matchColumns(humanColumns, fieldKeys, preset);
  const baselineMapping = matchColumns(modelColumns, fieldKeys);
  const used = new Set([
    ...Object.values(mapping),
    ...Object.values(baselineMapping),
  ]);

  return {
    mapping,
    baselineMapping,
    unmatchedFields: fieldKeys.filter((fieldKey) => !mapping[fieldKey]),
    unusedGoldColumns: labelColumns.filter((header) => !used.has(header)),
  };
}

export interface GoldFile {
  name: string;
  rows: CsvRow[];
}

export interface GoldFileSummary extends FieldMapping {
  name: string;
  rows: number;
}

const baselineKey = (fieldKey: string) => `baseline_${fieldKey}`;

/**
 * Turns gold files with different layouts into one list of rows with
 * session_id, sequence_id, role, content, one column per field, and
 * baseline_<field> for earlier model labels.
 */
export function standardizeGoldFiles(
  goldFiles: GoldFile[],
  fieldKeys: string[],
  overrides: Record<string, string> = {},
): { rows: CsvRow[]; files: GoldFileSummary[] } {
  const rows: CsvRow[] = [];
  const files: GoldFileSummary[] = [];

  for (const file of goldFiles) {
    if (file.rows.length === 0) continue;
    const standardized = standardizeTranscriptRows(file.rows);
    const fieldMapping = mapGoldColumnsToFields(
      Object.keys(file.rows[0]),
      fieldKeys,
      overrides,
    );
    files.push({ name: file.name, rows: file.rows.length, ...fieldMapping });

    for (const row of standardized) {
      const goldRow: CsvRow = {
        session_id: row.session_id,
        sequence_id: row.sequence_id,
        role: row.role,
        content: row.content,
        gold_file: file.name,
      };
      for (const fieldKey of fieldKeys) {
        const column = fieldMapping.mapping[fieldKey];
        if (column) goldRow[fieldKey] = row[column] ?? "";
        const baselineColumn = fieldMapping.baselineMapping[fieldKey];
        if (baselineColumn)
          goldRow[baselineKey(fieldKey)] = row[baselineColumn] ?? "";
      }
      rows.push(goldRow);
    }
  }

  return { rows, files };
}

export interface MatchedRow {
  ai: CsvRow;
  gold: CsvRow;
}

const orderKey = (row: CsvRow) =>
  row.session_id && row.sequence_id
    ? `${row.session_id.trim()}::${row.sequence_id.trim()}`
    : null;
const textKey = (row: CsvRow) => {
  const content = normalizeLabel(row.content);
  return content && content !== NA_LABEL
    ? `${(row.session_id ?? "").trim()}::${content}`
    : null;
};

/**
 * Lines up AI rows with gold rows (both standardized): by session +
 * sequence number, and by session + utterance text when the numbers differ.
 */
export function matchAiRowsToGold(
  aiRows: CsvRow[],
  goldRows: CsvRow[],
): {
  matched: MatchedRow[];
  byOrder: number;
  byText: number;
  unmatchedGold: number;
} {
  const byOrderMap = new Map<string, CsvRow>();
  const byTextMap = new Map<string, CsvRow>();
  for (const row of aiRows) {
    const order = orderKey(row);
    if (order && !byOrderMap.has(order)) byOrderMap.set(order, row);
    const text = textKey(row);
    if (text && !byTextMap.has(text)) byTextMap.set(text, row);
  }

  const matched: MatchedRow[] = [];
  let byOrder = 0;
  let byText = 0;
  let unmatchedGold = 0;
  for (const gold of goldRows) {
    const order = orderKey(gold);
    const orderMatch = order ? byOrderMap.get(order) : undefined;
    const sameText =
      orderMatch &&
      normalizeLabel(orderMatch.content) === normalizeLabel(gold.content);
    if (orderMatch && (sameText || !gold.content)) {
      matched.push({ ai: orderMatch, gold });
      byOrder++;
      continue;
    }
    const text = textKey(gold);
    const textMatch = text ? byTextMap.get(text) : undefined;
    if (textMatch) {
      matched.push({ ai: textMatch, gold });
      byText++;
    } else if (orderMatch) {
      // Same session and turn number, text differs slightly (e.g. encoding).
      matched.push({ ai: orderMatch, gold });
      byOrder++;
    } else {
      unmatchedGold++;
    }
  }

  return { matched, byOrder, byText, unmatchedGold };
}

export interface Disagreement {
  sessionId: string;
  sequence: string;
  role: string;
  content: string;
  gold: string;
  ai: string;
  reasoning: string;
}

export interface FieldEvaluation {
  fieldKey: string;
  goldColumns: string[];
  rows: number;
  agreement: number;
  kappa: number;
  interpretation: string;
  applicableRows: number;
  applicableAgreement: number;
  applicableKappa: number;
  macroF1: number;
  baselineKappa: number | null;
  baselineRows: number;
  topConfusions: { gold: string; ai: string; count: number }[];
  goldLabelsNotInCodebook: string[];
  disagreements: Disagreement[];
}

const round = (value: number) => Math.round(value * 1000) / 1000;

function agreementRate(a: string[], b: string[]): number {
  if (a.length === 0) return 0;
  return a.filter((label, index) => label === b[index]).length / a.length;
}

export function evaluateField({
  matched,
  fieldKey,
  goldColumns,
  codes = [],
}: {
  matched: MatchedRow[];
  fieldKey: string;
  goldColumns: string[];
  codes?: string[];
}): FieldEvaluation {
  const rowsWithGold = matched.filter((row) => fieldKey in row.gold);
  const aiColumn = `ai_${fieldKey}`;
  const goldLabels = rowsWithGold.map((row) =>
    normalizeLabel(row.gold[fieldKey]),
  );
  const aiLabels = rowsWithGold.map((row) => normalizeLabel(row.ai[aiColumn]));

  const applicableIndexes = goldLabels
    .map((label, index) => (label === NA_LABEL ? -1 : index))
    .filter((index) => index !== -1);
  const applicableGold = applicableIndexes.map((index) => goldLabels[index]);
  const applicableAi = applicableIndexes.map((index) => aiLabels[index]);

  const baselineRows = rowsWithGold.filter(
    (row) => baselineKey(fieldKey) in row.gold,
  );
  const baselineKappa = baselineRows.length
    ? round(
        calculateCohensKappa(
          baselineRows.map((row) =>
            normalizeLabel(row.gold[baselineKey(fieldKey)]),
          ),
          baselineRows.map((row) => normalizeLabel(row.gold[fieldKey])),
        ),
      )
    : null;

  const confusionCounts = new Map<string, number>();
  const disagreements: Disagreement[] = [];

  rowsWithGold.forEach((row, index) => {
    if (goldLabels[index] === aiLabels[index]) return;
    const key = `${goldLabels[index]}→${aiLabels[index]}`;
    confusionCounts.set(key, (confusionCounts.get(key) ?? 0) + 1);
    disagreements.push({
      sessionId: row.gold.session_id ?? "",
      sequence: row.gold.sequence_id ?? "",
      role: row.gold.role ?? "",
      content: row.gold.content ?? "",
      gold: row.gold[fieldKey] ?? "",
      ai: row.ai[aiColumn] ?? "",
      reasoning: row.ai.ai_reasoning ?? "",
    });
  });

  const knownCodes = new Set(codes.map(normalizeLabel));
  const goldLabelsNotInCodebook =
    codes.length > 0
      ? [
          ...new Set(
            goldLabels.flatMap((label) =>
              label === NA_LABEL ? [] : label.split(" + "),
            ),
          ),
        ].filter((label) => !knownCodes.has(label))
      : [];

  const kappa = calculateCohensKappa(aiLabels, goldLabels);

  return {
    fieldKey,
    goldColumns,
    rows: rowsWithGold.length,
    agreement: round(agreementRate(aiLabels, goldLabels)),
    kappa: round(kappa),
    interpretation: getKappaInterpretation(kappa),
    applicableRows: applicableIndexes.length,
    applicableAgreement: round(agreementRate(applicableAi, applicableGold)),
    applicableKappa: round(calculateCohensKappa(applicableAi, applicableGold)),
    macroF1: round(calculatePRF1(aiLabels, goldLabels).f1),
    baselineKappa,
    baselineRows: baselineRows.length,
    topConfusions: [...confusionCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([key, count]) => {
        const [gold, ai] = key.split("→");
        return { gold, ai, count };
      }),
    goldLabelsNotInCodebook,
    disagreements,
  };
}

export interface EvaluationReport {
  goldRows: number;
  matchedRows: number;
  matchedByOrder: number;
  matchedByText: number;
  unmatchedGoldRows: number;
  goldFiles: GoldFileSummary[];
  fields: FieldEvaluation[];
  unmatchedFields: string[];
}

export function evaluateAgainstGold({
  aiRows,
  goldFiles,
  fieldKeys,
  codesByField = {},
  overrides = {},
}: {
  aiRows: CsvRow[];
  goldFiles: GoldFile[];
  fieldKeys: string[];
  codesByField?: Record<string, string[]>;
  overrides?: Record<string, string>;
}): EvaluationReport {
  const { rows: goldRows, files } = standardizeGoldFiles(
    goldFiles,
    fieldKeys,
    overrides,
  );
  const standardizedAi = aiRows.length ? standardizeTranscriptRows(aiRows) : [];
  const { matched, byOrder, byText, unmatchedGold } = matchAiRowsToGold(
    standardizedAi,
    goldRows,
  );

  const columnsByField = (fieldKey: string) =>
    files
      .filter((file) => file.mapping[fieldKey])
      .map((file) =>
        files.length > 1
          ? `${file.name}: ${file.mapping[fieldKey]}`
          : file.mapping[fieldKey],
      );

  return {
    goldRows: goldRows.length,
    matchedRows: matched.length,
    matchedByOrder: byOrder,
    matchedByText: byText,
    unmatchedGoldRows: unmatchedGold,
    goldFiles: files,
    fields: fieldKeys
      .filter((fieldKey) => columnsByField(fieldKey).length > 0)
      .map((fieldKey) =>
        evaluateField({
          matched,
          fieldKey,
          goldColumns: columnsByField(fieldKey),
          codes: codesByField[fieldKey],
        }),
      )
      .filter((field) => field.rows > 0),
    unmatchedFields: fieldKeys.filter(
      (fieldKey) => columnsByField(fieldKey).length === 0,
    ),
  };
}

export function renderEvaluationMarkdown(
  report: EvaluationReport,
  title: string,
): string {
  const hasBaseline = report.fields.some(
    (field) => field.baselineKappa !== null,
  );
  const lines = [
    `# ${title}`,
    "",
    `Matched ${report.matchedRows} of ${report.goldRows} gold rows to AI rows (${report.matchedByOrder} by session + sequence, ${report.matchedByText} by session + text).` +
      (report.unmatchedGoldRows
        ? ` ${report.unmatchedGoldRows} gold rows have no AI row yet (not annotated).`
        : ""),
    "",
    "κ (all) counts every matched row, including NA. κ (non-NA) only counts rows where the gold label is not NA." +
      (hasBaseline
        ? " Previous AI κ compares earlier model labels stored in a gold file (columns marked (AI)) with the human labels, on the rows that have them."
        : ""),
    "",
    `| Field | Gold column | κ (all) | Agreement | κ (non-NA) | Non-NA rows | Macro F1 |${hasBaseline ? " Previous AI κ |" : ""}`,
    `| --- | --- | --- | --- | --- | --- | --- |${hasBaseline ? " --- |" : ""}`,
  ];

  for (const field of report.fields) {
    lines.push(
      `| ${field.fieldKey} | ${field.goldColumns.join("; ")} | ${field.kappa} (${field.interpretation}) | ${Math.round(field.agreement * 100)}% | ${field.applicableKappa} | ${field.applicableRows} | ${field.macroF1} |${hasBaseline ? ` ${field.baselineKappa ?? ""} |` : ""}`,
    );
  }

  if (report.unmatchedFields.length) {
    lines.push(
      "",
      `Not evaluated (no human-label column found): ${report.unmatchedFields.join(", ")}. Map them in input/column-map.json.`,
    );
  }
  for (const file of report.goldFiles) {
    if (file.unusedGoldColumns.length) {
      lines.push(
        "",
        `${file.name}: columns not used: ${file.unusedGoldColumns.join(", ")}.`,
      );
    }
  }

  for (const field of report.fields) {
    if (
      field.topConfusions.length === 0 &&
      field.goldLabelsNotInCodebook.length === 0
    )
      continue;
    lines.push("", `## ${field.fieldKey}`, "");
    for (const confusion of field.topConfusions) {
      lines.push(
        `- Gold **${confusion.gold}** → AI **${confusion.ai}**: ${confusion.count} rows`,
      );
    }
    if (field.goldLabelsNotInCodebook.length) {
      lines.push(
        `- Gold labels that are not codes in the codebook: ${field.goldLabelsNotInCodebook.join(", ")}`,
      );
    }
  }

  return lines.join("\n") + "\n";
}

export type CsvRow = Record<string, string>;

export interface LocalUtterance {
  _id: string;
  role: string;
  content: string;
}

export interface LocalSession {
  sessionId: string;
  rows: CsvRow[];
  transcript: LocalUtterance[];
  leadRole: string;
}

export interface LocalAnnotation {
  _id: string;
  reasoning?: string;
  [field: string]: unknown;
}

const SESSION_COLUMNS = [
  "session id",
  "session",
  "chat id",
  "conversation id",
  "conversation",
];
// Used together when there is no session column, e.g. "student (shortened
// code)" + "question": one session per student per question.
const PERSON_COLUMNS = [
  "student",
  "student id",
  "participant id",
  "participant",
  "user id",
];
const TOPIC_COLUMNS = ["question", "question id", "problem", "problem id"];
const ROLE_COLUMNS = ["role", "speaker", "sender", "message type", "author"];
const CONTENT_COLUMNS = ["content", "text", "message", "utterance"];
const ORDER_COLUMNS = [
  "sequence id",
  "sequence",
  "turn",
  "order",
  "index",
  "number",
];

const ROLE_NAMES: Record<string, string> = {
  s: "Student",
  student: "Student",
  prompt: "Student",
  user: "Student",
  human: "Student",
  t: "Tutor",
  tutor: "Tutor",
  response: "Tutor",
  assistant: "Tutor",
  bot: "Tutor",
  ai: "Tutor",
};

/** "message_type (prompt form student, response from bot)" → "message type"; "#" → "number". */
export function normalizeHeader(header: string): string {
  if (header.trim() === "#") return "number";
  return header
    .replace(/\([^)]*\)/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function findColumn(headers: string[], candidates: string[]): string | null {
  const normalized = headers.map(normalizeHeader);
  for (const candidate of candidates) {
    const index = normalized.indexOf(candidate);
    if (index !== -1) return headers[index];
  }
  return null;
}

export interface DetectedColumns {
  session: string | null;
  sessionParts: string[];
  role: string | null;
  content: string | null;
  order: string | null;
}

export function detectColumns(headers: string[]): DetectedColumns {
  const session = findColumn(headers, SESSION_COLUMNS);
  const person = findColumn(headers, PERSON_COLUMNS);
  const topic = findColumn(headers, TOPIC_COLUMNS);
  return {
    session,
    sessionParts: session
      ? [session]
      : [person, topic].filter((column): column is string => !!column),
    role: findColumn(headers, ROLE_COLUMNS),
    content: findColumn(headers, CONTENT_COLUMNS),
    order: findColumn(headers, ORDER_COLUMNS),
  };
}

/** Expands speaker codes (S/T, prompt/response, user/assistant) to Student/Tutor. */
export function normalizeRole(role: string): string {
  const trimmed = (role ?? "").trim();
  return ROLE_NAMES[trimmed.toLowerCase()] ?? trimmed;
}

/**
 * Gives every row the standard columns session_id, sequence_id, role and
 * content, whatever the file called them. Other columns are kept.
 */
export function standardizeTranscriptRows(rows: CsvRow[]): CsvRow[] {
  if (rows.length === 0) return [];
  const columns = detectColumns(Object.keys(rows[0]));
  if (columns.sessionParts.length === 0 || !columns.role || !columns.content) {
    throw new Error(
      `The CSV needs session, speaker and text columns (e.g. session_id, speaker or role, content or text). Found: ${Object.keys(rows[0]).join(", ")}`,
    );
  }
  return rows.map((row, index) => ({
    ...row,
    session_id: columns.sessionParts
      .map((column) => (row[column] ?? "").trim())
      .join(" / "),
    sequence_id: columns.order
      ? (row[columns.order] ?? "").trim()
      : String(index + 1),
    role: normalizeRole(row[columns.role!]),
    content: row[columns.content!] ?? "",
  }));
}

/**
 * Groups CSV rows (one row per utterance) into sessions shaped like the
 * transcripts Sandpiper sends to the annotation prompt.
 */
export function buildSessionsFromCsvRows(
  rows: CsvRow[],
  { maxSessions }: { maxSessions: number },
): LocalSession[] {
  if (rows.length === 0) return [];

  const columns = detectColumns(Object.keys(rows[0]));
  if (columns.sessionParts.length === 0 || !columns.role || !columns.content) {
    throw new Error(
      `The CSV needs session, speaker and text columns (e.g. session_id, speaker or role, content or text). Found: ${Object.keys(rows[0]).join(", ")}`,
    );
  }
  const sessionIdOf = (row: CsvRow) =>
    columns.sessionParts
      .map((column) => (row[column] ?? "").trim())
      .join(" / ");

  const bySession = new Map<string, CsvRow[]>();
  for (const row of rows) {
    const sessionId = sessionIdOf(row);
    if (!sessionId.replace(/[\s/]/g, "")) continue;
    if (!bySession.has(sessionId)) {
      if (bySession.size >= maxSessions) continue;
      bySession.set(sessionId, []);
    }
    bySession.get(sessionId)!.push(row);
  }

  const sessions: LocalSession[] = [];
  for (const [sessionId, sessionRows] of bySession) {
    const ordered = columns.order
      ? [...sessionRows].sort(
          (a, b) => Number(a[columns.order!]) - Number(b[columns.order!]),
        )
      : sessionRows;

    const transcript = ordered.map((row, index) => ({
      _id: String(index),
      role: normalizeRole(row[columns.role!]),
      content: row[columns.content!] ?? "",
    }));

    const roles = new Set(transcript.map((utterance) => utterance.role));
    const leadRole = roles.has("Tutor")
      ? "Tutor"
      : (transcript[0]?.role ?? "Tutor");

    sessions.push({ sessionId, rows: ordered, transcript, leadRole });
  }

  return sessions;
}

/**
 * Adds one column per annotation field (plus reasoning) to each utterance's
 * original CSV row. Several annotations on one utterance are joined with " | ".
 */
export function mergeAnnotationsIntoRows(
  session: LocalSession,
  annotations: LocalAnnotation[],
  fieldKeys: string[],
): CsvRow[] {
  return session.rows.map((row, index) => {
    const matching = annotations.filter(
      (annotation) => String(annotation._id) === String(index),
    );
    const merged: CsvRow = { ...row };
    for (const fieldKey of [...fieldKeys, "reasoning"]) {
      merged[`ai_${fieldKey}`] = matching
        .map((annotation) => annotation[fieldKey])
        .filter((value) => value !== undefined && value !== "")
        .map(String)
        .join(" | ");
    }
    return merged;
  });
}

function escapeCsvValue(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(rows: CsvRow[]): string {
  if (rows.length === 0) return "";
  const headers = Array.from(
    rows.reduce((set, row) => {
      Object.keys(row).forEach((key) => set.add(key));
      return set;
    }, new Set<string>()),
  );
  const lines = [headers.map(escapeCsvValue).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeCsvValue(row[h] ?? "")).join(","));
  }
  return lines.join("\n") + "\n";
}

import type { LocalAnnotation, LocalSession } from "./transcripts";

export type AskModel = (user: string) => Promise<{
  annotations?: LocalAnnotation[];
}>;

export interface SessionResult {
  annotations: LocalAnnotation[];
  /** Utterance _ids the model still did not annotate. */
  missingIds: string[];
  calls: number;
}

export const UTTERANCES_PER_REQUEST = 20;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function userMessage(
  promptText: string,
  session: LocalSession,
  ids: string[],
): string {
  return [
    promptText,
    "",
    `Conversation: ${JSON.stringify({ transcript: session.transcript, leadRole: session.leadRole })}`,
    "",
    `Annotate exactly these utterances, with at least one annotation for each _id: ${ids.join(", ")}.`,
    "Use the whole conversation as context. Give every category a code for every one of these utterances; use the NA code when a category doesn't apply (for example a student category on a tutor utterance).",
  ].join("\n");
}

/**
 * Coding schemes need a label on every utterance, but models (especially
 * small ones) often annotate only a few. So the session is asked for in
 * slices of utterance _ids, and any _ids still missing are asked for again
 * once.
 */
export async function annotateSession({
  session,
  promptText,
  ask,
  utterancesPerRequest = UTTERANCES_PER_REQUEST,
}: {
  session: LocalSession;
  promptText: string;
  ask: AskModel;
  utterancesPerRequest?: number;
}): Promise<SessionResult> {
  const allIds = session.transcript.map((utterance) => utterance._id);
  const valid = new Set(allIds);
  const annotations: LocalAnnotation[] = [];
  const covered = new Set<string>();
  let calls = 0;

  const request = async (ids: string[]) => {
    const wanted = new Set(ids);
    const response = await ask(userMessage(promptText, session, ids));
    calls++;
    for (const annotation of response.annotations ?? []) {
      const id = String(annotation?._id ?? "");
      // Ignore unknown ids and ones another request already covered.
      if (!valid.has(id) || (covered.has(id) && !wanted.has(id))) continue;
      annotations.push({ ...annotation, _id: id });
    }
    for (const id of ids) {
      if (annotations.some((annotation) => annotation._id === id)) {
        covered.add(id);
      }
    }
  };

  for (const ids of chunk(allIds, utterancesPerRequest)) {
    await request(ids);
  }

  const missing = allIds.filter((id) => !covered.has(id));
  for (const ids of chunk(missing, utterancesPerRequest)) {
    await request(ids);
  }

  return {
    annotations,
    missingIds: allIds.filter((id) => !covered.has(id)),
    calls,
  };
}

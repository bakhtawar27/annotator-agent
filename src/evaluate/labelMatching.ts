/**
 * Human labels often differ slightly from the codebook's code names: typos
 * ("Specifc question"), singular/plural ("Ask follow-up question" vs
 * "ask follow-up questions"), small words ("Check for understanding" vs
 * "check student understanding"). The model can only answer with codebook
 * codes, so such labels would always count as disagreements. This maps each
 * human label to a codebook code when the match is clear, and leaves it
 * alone otherwise. Every mapping is reported so a person can check it.
 */

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "of",
  "for",
  "to",
  "on",
  "in",
  "student",
  "students",
]);

const MIN_SIMILARITY = 0.85;

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

export function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 1 : 1 - levenshtein(a, b) / longest;
}

function stem(word: string): string {
  return word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;
}

function contentWords(label: string): string[] {
  return label
    .split(" ")
    .filter((word) => word && !STOPWORDS.has(word))
    .map(stem);
}

function sameWords(a: string, b: string): boolean {
  const wordsA = new Set(contentWords(a));
  const wordsB = new Set(contentWords(b));
  if (wordsA.size === 0 || wordsA.size !== wordsB.size) return false;
  for (const word of wordsA) if (!wordsB.has(word)) return false;
  return true;
}

const NEGATING_PREFIXES = ["dis", "non", "in", "un", "im", "ir", "en"];

function root(word: string): string {
  for (const prefix of NEGATING_PREFIXES) {
    if (word.startsWith(prefix) && word.length - prefix.length >= 4) {
      return word.slice(prefix.length);
    }
  }
  return word;
}

/** "correct" vs "incorrect", "encouragement" vs "discouragement". */
function isOpposite(a: string, b: string): boolean {
  return a !== b && root(a) === root(b);
}

/**
 * Fuzzy matches only fix spelling: same number of words, each word close to
 * its partner, and no word turned into its opposite.
 */
function wordsCompatible(a: string[], b: string[]): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  return a.every(
    (word, index) =>
      word === b[index] ||
      (!isOpposite(word, b[index]) && similarity(word, b[index]) >= 0.7),
  );
}

function isSubset(small: string[], large: string[]): boolean {
  const set = new Set(large);
  return small.length > 0 && small.every((word) => set.has(word));
}

/**
 * Returns the codebook code a (normalized) human label most likely means, or
 * null when there is no clear single match. `codes` are normalized codes.
 */
export function matchLabelToCode(
  label: string,
  codes: string[],
): string | null {
  if (codes.includes(label)) return label;

  const byWords = codes.filter((code) => sameWords(label, code));
  if (byWords.length === 1) return byWords[0];

  let best: { code: string; score: number } | null = null;
  let secondScore = 0;
  const labelContent = contentWords(label);
  for (const code of codes) {
    if (!wordsCompatible(labelContent, contentWords(code))) continue;
    const score = Math.max(
      similarity(label, code),
      similarity(contentWords(label).join(" "), contentWords(code).join(" ")),
    );
    if (!best || score > best.score) {
      secondScore = best?.score ?? 0;
      best = { code, score };
    } else if (score > secondScore) {
      secondScore = score;
    }
  }
  if (best && best.score >= MIN_SIMILARITY && best.score - secondScore > 0.05) {
    return best.code;
  }

  // A shortened label whose words all appear in exactly one longer code
  // ("provide part of correct answer"), or a longer label containing all
  // the words of exactly one code ("execution solution" → "execution").
  const labelWords = contentWords(label);
  const containing = codes.filter((code) => {
    const codeWords = contentWords(code);
    return (
      (labelWords.length >= 3 && isSubset(labelWords, codeWords)) ||
      (codeWords.length >= 1 &&
        isSubset(codeWords, labelWords) &&
        labelWords.length - codeWords.length <= 1)
    );
  });
  return containing.length === 1 ? containing[0] : null;
}

export interface LabelMapping {
  from: string;
  to: string;
  count: number;
}

/** Remembers which labels were mapped, for the report. */
export class LabelMatcher {
  private readonly codes: string[];
  private readonly cache = new Map<string, string | null>();
  private readonly counts = new Map<string, number>();

  constructor(normalizedCodes: string[]) {
    this.codes = normalizedCodes;
  }

  map(label: string): string {
    if (this.codes.length === 0) return label;
    if (!this.cache.has(label)) {
      this.cache.set(label, matchLabelToCode(label, this.codes));
    }
    const match = this.cache.get(label);
    if (!match || match === label) return label;
    const key = `${label}→${match}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    return match;
  }

  mappings(): LabelMapping[] {
    return [...this.counts.entries()]
      .map(([key, count]) => {
        const [from, to] = key.split("→");
        return { from, to, count };
      })
      .sort((a, b) => b.count - a.count);
  }
}

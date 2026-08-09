import type { Message } from "@earendil-works/pi-ai";
import type { RenderedEntry } from "./render-entries";
import { textOf, isContentBearing, extractToolCallText } from "./content";

export interface SearchHit extends RenderedEntry {
  /** Context snippet around the first matched term (only when query provided) */
  snippet?: string;
  /** Number of query terms matched (for ranking) */
  matchCount?: number;
}
/** A file touched in one entry — used by mode:touched aggregation. */
export interface FileTouch {
  index: number;
  toolName: string;
}

/** Aggregated view of a file touched across multiple entries. */
export interface TouchedFile {
  path: string;
  entries: FileTouch[];
}
const escapeRegex = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Quantifier starting at `i`, if any. Only unbounded forms (+, *, {n,}) can
 *  drive catastrophic backtracking. */
const quantifierAt = (p: string, i: number): { len: number; unbounded: boolean } => {
  const c = p[i];
  if (c === "+" || c === "*") return { len: 1, unbounded: true };
  if (c === "{") {
    const end = p.indexOf("}", i);
    const body = end === -1 ? "" : p.slice(i + 1, end);
    if (/^\d+(,\d*)?$/.test(body)) return { len: end - i + 1, unbounded: body.endsWith(",") };
  }
  return { len: 0, unbounded: false };
};

/**
 * Detect an unbounded quantifier applied to a group that already contains one,
 * e.g. `(a+)+` or `(\w*)*`. That shape makes the engine explore exponentially
 * many splits on a non-matching input. Alternation overlap like `(a|a)+` is not
 * covered here; the search budget in `searchEntries` is the backstop.
 */
const hasNestedQuantifier = (pattern: string): boolean => {
  const groups: boolean[] = []; // per open group: contains an unbounded quantifier
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") { i++; continue; }
    if (inClass) { if (c === "]") inClass = false; continue; }
    if (c === "[") { inClass = true; continue; }
    if (c === "(") { groups.push(false); continue; }
    if (c === ")") {
      const inner = groups.pop() ?? false;
      const q = quantifierAt(pattern, i + 1);
      if (inner && q.unbounded) return true;
      if (groups.length) groups[groups.length - 1] ||= inner || q.unbounded;
      i += q.len;
      continue;
    }
    const q = quantifierAt(pattern, i);
    if (q.unbounded && groups.length) {
      groups[groups.length - 1] = true;
      i += q.len - 1;
    }
  }
  return false;
};

/** Try to compile as regex; fall back to escaped literal. Patterns with nested
 *  unbounded quantifiers are treated as literals rather than compiled. */
const safeRegex = (pattern: string): RegExp => {
  if (hasNestedQuantifier(pattern)) return new RegExp(escapeRegex(pattern), "i");
  try {
    return new RegExp(pattern, "i");
  } catch {
    return new RegExp(escapeRegex(pattern), "i");
  }
};

/**
 * Wall-clock budget for one search. A normal query over 400 entries takes ~10ms,
 * so this only trips on pathological patterns that survive `hasNestedQuantifier`.
 * Aborting loudly beats returning a silently truncated match count.
 *
 * This is a per-entry checkpoint, not a hard per-call ceiling: JavaScript cannot
 * interrupt a running `RegExp.test`, so a single pathological entry still runs to
 * completion and the overshoot is caught on the next iteration. That bounds the
 * damage to one entry instead of the whole corpus, which is the point — the
 * unbounded case was N entries multiplied by the per-entry cost.
 */
const SEARCH_BUDGET_MS = 3000;

const startBudget = (): (() => void) => {
  const deadline = Date.now() + SEARCH_BUDGET_MS;
  return () => {
    if (Date.now() > deadline) {
      throw new Error(
        `Search aborted: query exceeded ${SEARCH_BUDGET_MS}ms. Simplify the pattern — ` +
        "nested quantifiers such as (a+)+ can make matching blow up.",
      );
    }
  };
};

/** Detect if the query looks like a single regex pattern (contains regex metacharacters). */
const looksLikeRegex = (query: string): boolean =>
  /[|*+?{}()[\]\\^$.]/.test(query);

/** Build a regex for snippet highlighting — matches first available term. */
const snippetRegex = (terms: string[]): RegExp => {
  const alts = terms.map((t) => safeRegex(t).source);
  return new RegExp(alts.join("|"), "i");
};

// ── Stopwords for natural language queries ──
const STOPWORDS = new Set([
  // English
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "of", "in", "to", "for",
  "with", "on", "at", "from", "by", "as", "into", "through", "during",
  "before", "after", "above", "below", "between", "out", "off", "over",
  "under", "again", "further", "then", "once", "here", "there", "when",
  "where", "why", "how", "all", "both", "each", "few", "more", "most",
  "other", "some", "such", "no", "nor", "not", "only", "own", "same",
  "so", "than", "too", "very", "just", "about", "it", "its", "that",
  "this", "what", "which", "who", "whom", "these", "those",
]);

/** Remove stopwords, keep meaningful terms. */
const filterStopwords = (terms: string[]): string[] => {
  const meaningful = terms.filter((t) => !STOPWORDS.has(t.toLowerCase()) && t.length > 1);
  // If all terms were stopwords, return original (don't lose everything)
  return meaningful.length > 0 ? meaningful : terms;
};

/** Count how many distinct terms match the haystack. */
const countMatches = (hay: string, terms: string[]): number => {
  let count = 0;
  for (const t of terms) {
    if (safeRegex(t).test(hay)) count++;
  }
  return count;
};

// ── BM25-lite scoring ──
const BM25_K = 1.2;
const BM25_B = 0.75;

/** Count occurrences of a regex pattern in text. */
const termFreq = (text: string, pattern: RegExp): number => {
  const matches = text.match(new RegExp(pattern.source, "gi"));
  return matches ? matches.length : 0;
};

interface BM25Context {
  n: number;         // total docs
  avgDl: number;     // average doc length (words)
  df: Map<string, number>; // term -> number of docs containing it
}

/** Precompute IDF and avgDl across all docs. */
const buildBM25Context = (docs: string[], terms: string[], checkBudget: () => void): BM25Context => {
  const n = docs.length;
  const df = new Map<string, number>();
  let totalLen = 0;

  for (const doc of docs) {
    checkBudget();
    totalLen += doc.split(/\s+/).length;
    for (const t of terms) {
      if (safeRegex(t).test(doc)) {
        df.set(t, (df.get(t) ?? 0) + 1);
      }
    }
  }

  return { n, avgDl: totalLen / Math.max(n, 1), df };
};

/** BM25 score for a single doc against query terms. */
const bm25Score = (doc: string, terms: string[], ctx: BM25Context): number => {
  const dl = doc.split(/\s+/).length;
  let score = 0;

  for (const t of terms) {
    const tf = termFreq(doc, safeRegex(t));
    if (tf === 0) continue;

    const docFreq = ctx.df.get(t) ?? 0;
    // IDF: log((N - df + 0.5) / (df + 0.5) + 1)
    const idf = Math.log((ctx.n - docFreq + 0.5) / (docFreq + 0.5) + 1);
    // TF saturation with length normalization
    const tfNorm = (tf * (BM25_K + 1)) / (tf + BM25_K * (1 - BM25_B + BM25_B * dl / ctx.avgDl));
    score += idf * tfNorm;
  }

  return score;
};

/** Line-based snippet: ±contextLines around first regex match. */
const lineSnippet = (text: string, regex: RegExp, contextLines = 2): string | undefined => {
  const lines = text.split("\n");
  let matchIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      matchIdx = i;
      break;
    }
  }
  if (matchIdx === -1) return undefined;

  const start = Math.max(0, matchIdx - contextLines);
  const end = Math.min(lines.length, matchIdx + contextLines + 1);
  const slice = lines.slice(start, end);

  const parts: string[] = [];
  if (start > 0) parts.push(`...(${start} lines above)`);
  parts.push(...slice);
  if (end < lines.length) parts.push(`...(${lines.length - end} lines below)`);
  return parts.join("\n");
};

/** Build full searchable text for a message. */
const fullText = (msg: Message): string => {
  if ((msg as any).role === "bashExecution") {
    return `${(msg as any).command ?? ""} ${(msg as any).output ?? ""}`;
  }
  return textOf(msg.content);
};

/**
 * Compute file indicators from a message, counting non-empty content lines
 * per content-bearing file call. Shape-based — no tool-name allowlist.
 *
 * Ported from pi-blackhole (https://github.com/k0valik/pi-blackhole, MIT) by
 * k0valik — a pi-vcc derivative.
 */
export function getFileIndicators(msg: Message): { toolName: string; path: string; lineCount: number }[] {
  if (!msg?.content || typeof msg.content === "string") return [];
  const indicators: { toolName: string; path: string; lineCount: number }[] = [];
  for (const part of msg.content) {
    if (!part || typeof part !== "object" || part.type !== "toolCall") continue;
    const args = part.arguments as Record<string, unknown>;
    if (!isContentBearing(args)) continue;
    const path = ["path", "filePath", "file_path", "file"]
      .map((k) => args[k])
      .find((v): v is string => typeof v === "string")!;
    const totalText = extractToolCallText(args);
    const nonEmpty = totalText.split("\n").filter((l) => l.trim().length > 0);
    indicators.push({
      toolName: part.name || "",
      path,
      lineCount: nonEmpty.length,
    });
  }
  return indicators;
}

/**
 * Aggregate file operations across all entries for mode:touched.
 *
 * Ported from pi-blackhole (https://github.com/k0valik/pi-blackhole, MIT) by
 * k0valik — a pi-vcc derivative.
 */
export function getTouchedFiles(
  messages: Message[],
  rendered: RenderedEntry[],
): TouchedFile[] {
  const map = new Map<string, TouchedFile>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const indicators = getFileIndicators(msg);
    for (const fm of indicators) {
      const index = rendered[i]?.index ?? i;
      if (!map.has(fm.path)) {
        map.set(fm.path, { path: fm.path, entries: [] });
      }
      (map.get(fm.path) as TouchedFile).entries.push({ index, toolName: fm.toolName });
    }
  }
  return Array.from(map.values());
}

export const searchEntries = (
  entries: RenderedEntry[],
  messages: Message[],
  query?: string,
): SearchHit[] => {
  if (!query?.trim()) return entries;

  const rawQuery = query.trim();
  const checkBudget = startBudget();

  // If the query looks like a single regex pattern (contains metacharacters),
  // treat the whole thing as one pattern — don't split into terms.
  //
  // The detection is deliberately loose, so ordinary prose trips it: a trailing
  // "?" or "." turns the whole sentence into one pattern that must match
  // verbatim. On real sessions that path returned nothing 47.5% of the time
  // versus 1.1% for term search. Mode detection must never silently lose
  // results, so an empty regex result falls through to term search below.
  if (looksLikeRegex(rawQuery)) {
    const regex = safeRegex(rawQuery);
    const hits: SearchHit[] = [];
    for (let i = 0; i < entries.length; i++) {
      checkBudget();
      const e = entries[i];
      const msg = messages[i];
      const text = msg ? fullText(msg) : e.summary;
      const filePart = e.files?.join(" ") ?? "";
      const hay = `${e.role} ${text} ${filePart}`;
      if (regex.test(hay)) {
        const snip = lineSnippet(text, regex);
        hits.push({ ...e, snippet: snip, matchCount: 1 });
      }
    }
    if (hits.length > 0) return hits;
  }

  // Natural language / multi-word query: BM25 scoring
  const rawTerms = rawQuery.split(/\s+/);
  const terms = filterStopwords(rawTerms);
  const snipRe = snippetRegex(terms);

  // Build all docs for BM25 context
  const docs: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const msg = messages[i];
    const text = msg ? fullText(msg) : e.summary;
    const filePart = e.files?.join(" ") ?? "";
    docs.push(`${e.role} ${text} ${filePart}`);
  }

  const ctx = buildBM25Context(docs, terms, checkBudget);

  const scored: Array<{ hit: SearchHit; score: number }> = [];
  for (let i = 0; i < entries.length; i++) {
    checkBudget();
    const e = entries[i];
    const hay = docs[i];
    const mc = countMatches(hay, terms);
    if (mc === 0) continue;
    const score = bm25Score(hay, terms, ctx);
    const text = messages[i] ? fullText(messages[i]) : e.summary;
    const snip = lineSnippet(text, snipRe);
    scored.push({
      hit: { ...e, snippet: snip, matchCount: mc },
      score,
    });
  }

  // Sort by BM25 score desc
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.hit);
};

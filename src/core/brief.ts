import type { NormalizedBlock } from "../types";
import { clip } from "./content";
import { extractPath } from "./tool-args";
import { collapseSkillText } from "./skill-collapse";

const TRUNCATE_USER = 256;
const SEGMENT_CLOSING_ASSISTANT_HEAD_WORDS = 120;
const SEGMENT_CLOSING_ASSISTANT_TAIL_WORDS = 120;
const ASSISTANT_HEAD_WORDS = 80;
const ASSISTANT_TAIL_WORDS = 120;

// Strip common self-reflective assistant prefixes that carry no semantic info.
// Conservative list: only removes the leading filler, preserves the actual content.
const SELF_TALK_PREFIX_RE =
  /^\s*(?:hmm|wait|actually|oh|okay|ok|well|so)[,.!\s-]+/i;

// ── noise filtering ──

const isNoiseUser = (text: string): boolean => {
  return !text.trim();
};

// ── truncation ──

// Unicode-aware word segmentation via Intl.Segmenter (built-in, zero dependency)
const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/** Check if segment is a word (Bun's isWordLike is unreliable for alphanumeric tokens) */
const isWord = (seg: { segment: string; isWordLike?: boolean }): boolean =>
  Boolean(seg.isWordLike) || /[\p{L}\p{N}]/u.test(seg.segment);

// Common stop words — don't count toward budget
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "must",
  "to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
  "into", "through", "during", "before", "after", "above", "below",
  "between", "under", "over",
  "and", "but", "or", "nor", "not", "so", "yet", "both", "either",
  "neither", "each", "every", "all", "any", "few", "more", "most",
  "other", "some", "such", "no",
  "that", "this", "these", "those", "it", "its",
  "i", "me", "my", "we", "our", "you", "your", "he", "him", "his",
  "she", "her", "they", "them", "their", "who", "which", "what",
  "if", "then", "than", "when", "where", "how", "just", "also",
]);

const normalizeForTokenBudget = (text: string): string =>
  text
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const truncateTokens = (text: string, limit: number): string => {
  const flat = normalizeForTokenBudget(text);
  let count = 0;
  let lastEnd = 0;
  for (const seg of segmenter.segment(flat)) {
    if (isWord(seg)) {
      if (!STOP_WORDS.has(seg.segment.toLowerCase())) {
        count++;
        if (count > limit) {
          return flat.slice(0, lastEnd).trimEnd() + "...(truncated)";
        }
      }
    }
    lastEnd = seg.index + seg.segment.length;
  }
  return flat;
};

const significantWordSpans = (flat: string): { start: number; end: number }[] => {
  const words: { start: number; end: number }[] = [];
  for (const seg of segmenter.segment(flat)) {
    if (!isWord(seg)) continue;
    if (STOP_WORDS.has(seg.segment.toLowerCase())) continue;
    words.push({ start: seg.index, end: seg.index + seg.segment.length });
  }
  return words;
};


const truncateTokensHeadTail = (text: string, headLimit: number, tailLimit: number): string => {
  const flat = normalizeForTokenBudget(text);
  if (headLimit <= 0 || tailLimit <= 0) return flat;
  const words = significantWordSpans(flat);
  if (words.length <= headLimit + tailLimit) return flat;
  const head = flat.slice(0, words[headLimit - 1].end).trimEnd();
  const tail = flat.slice(words[words.length - tailLimit].start).trimStart();
  return `${head}\n...(middle truncated)...\n${tail}`;
};

const nextRenderableBlock = (blocks: NormalizedBlock[], index: number): NormalizedBlock | undefined => {
  for (let i = index + 1; i < blocks.length; i++) {
    if (blocks[i].kind !== "tool_result") return blocks[i];
  }
  return undefined;
};

const isSegmentClosingAssistant = (blocks: NormalizedBlock[], index: number): boolean => {
  if (blocks[index]?.kind !== "assistant") return false;
  const next = nextRenderableBlock(blocks, index);
  return !next || next.kind === "user" || next.kind === "custom" || next.kind === "branch_summary";
};

// ── bash command compression ──

const BASH_CAP = 240;
const PIPE_TAIL_RE = /\s*\|\s*(?:head|tail|sort|wc|column|tr|cut|awk|uniq|python3|node|bun)(?:\s[^|]*)?$/;
// Preamble/boilerplate lines that carry no durable fact on their own. Dropped
// when a script has more informative lines, so `set -euo pipefail\ngit commit`
// renders the commit rather than the shell option.
const TRIVIAL_LINE_RE = /^(?:set\s+[-+]|cd\s+\S+$|export\s+\w+=|(?:source|\.)\s+\S+|pwd$|true$|:$|#)/;
// A real heredoc opener: `<<` at a command boundary — not preceded by a word
// char or `)`, so shift ops (`8 << 20`, `Rd<<8`) are not misread — with an
// identifier terminator starting [A-Za-z_], so numeric `<< 10` is rejected too.
export const HEREDOC_OPEN_RE = /(?<![\w)])<<-?\s*["']?([A-Za-z_]\w*)["']?/;
// File-writer heredocs (`cat > f <<EOF`, tee, dd) already name their target, so
// the opener alone is informative → body-only. EVERY other heredoc has a
// content-free opener (interpreters python3/node, remote shells `ssh host <<CMD`,
// sqlite3, ...) → we surface a one-line body preview. This denylist replaces an
// interpreter allowlist that missed ssh/sqlite3/etc. and mis-handled heredocs
// combined with a `>` redirect.
const FILEWRITER_HEREDOC_RE = /(?:^|[|&;]\s*)(?:cat|tee|dd)\b/;
const HEREDOC_BODY_CAP = 80;
// Body lines that are pure boilerplate and make a poor preview.
const BODY_NOISE_RE = /^(?:import\s|from\s+\S+\s+import|require\(|const\s+\w+\s*=\s*require|#|\/\/|"""|'''|"use strict"|use\s+strict|<\?php)/;

/**
 * If `lines[i]` opens a heredoc whose terminator actually appears on a later
 * line, return that terminator's line index; otherwise -1. Callers use -1 to
 * leave following lines intact instead of treating a stray `<<` (a shift op, a
 * quoted string, or a truncated body) as a heredoc and skipping real commands.
 */
export const heredocCloseIndex = (lines: string[], i: number): number => {
  const hd = lines[i].match(HEREDOC_OPEN_RE);
  if (!hd) return -1;
  const term = hd[1];
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].trim() === term) return j;
  }
  return -1;
};

const stripCdPrefix = (line: string): string => line.replace(/^cd\s+\S+\s*&&\s*/, "").trim();
const stripPipeTail = (line: string): string => {
  let c = line;
  for (let i = 0; i < 3; i++) {
    const stripped = c.replace(PIPE_TAIL_RE, "");
    if (stripped === c) break;
    c = stripped;
  }
  return c.trim();
};

/**
 * Semantic compression of a (possibly multi-line) bash command.
 * 1. Drop heredoc BODIES (keep the opener line, e.g. `cat > f <<EOF` or
 *    `python3 - <<PY`): the body is prose/script content that bloats the brief
 *    without adding countable facts, while the opener still records what ran.
 * 2. Drop trivial preamble lines (set -euo pipefail, cd-only, export, source,
 *    comments) unless they are the ONLY line, so real work below them surfaces.
 * 3. Strip `cd <path> &&` prefixes and pipe-tail formatting per line.
 * 4. Join the remaining meaningful lines with `; ` and cap length.
 */
const compressBash = (raw: string): string => {
  // Pass 1: keep heredoc opener lines, skip their bodies + terminators.
  const rawLines = raw.split("\n");
  const withoutHeredocBodies: string[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    withoutHeredocBodies.push(line);
    // Only treat this as a heredoc when its terminator appears downstream; a
    // stray `<<` (string/expression or truncated body) leaves later lines intact.
    const close = heredocCloseIndex(rawLines, i);
    if (close === -1) continue;
    // File-writer heredocs (`cat > f <<EOF`) name their target → keep opener only.
    // Every other heredoc has a content-free opener → grab the first meaningful
    // body line as a preview (`python3 - <<PY`, `ssh host <<CMD`, `sqlite3 <<SQL`).
    const wantPreview = !FILEWRITER_HEREDOC_RE.test(line);
    let preview = "";
    for (let j = i + 1; wantPreview && !preview && j < close; j++) {
      const t = rawLines[j].trim();
      if (t && !BODY_NOISE_RE.test(t)) preview = t;
    }
    if (preview) {
      const clipped = preview.length > HEREDOC_BODY_CAP ? preview.slice(0, HEREDOC_BODY_CAP - 1) + "\u2026" : preview;
      withoutHeredocBodies[withoutHeredocBodies.length - 1] = `${line.trim()} ${clipped}`;
    }
    i = close; // for-loop's i++ then skips past the terminator line
  }

  const lines = withoutHeredocBodies.map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return raw.trim();

  const meaningful = lines
    .filter(l => !TRIVIAL_LINE_RE.test(l))
    .map(l => stripPipeTail(stripCdPrefix(l)))
    .filter(Boolean);
  // If everything was trivial (e.g. a bare `set -e` or `ls`), fall back to the
  // first line so we never emit an empty marker.
  const chosen = meaningful.length ? meaningful : [stripPipeTail(stripCdPrefix(lines[0]))].filter(Boolean);

  const cmd = chosen.join("; ");
  if (cmd.length > BASH_CAP) {
    return cmd.slice(0, BASH_CAP - 3) + "...";
  }
  return cmd;
};

// ── tool summary ──

const TOOL_SUMMARY_FIELDS: Record<string, string> = {
  read: "path",
  write: "path",
  edit: "path",
  grep: "pattern",
  find: "pattern",
  ls: "path",
  bash: "command",
  powershell: "command",
  glob: "pattern",
};

const toolOneLiner = (name: string, args: Record<string, unknown>): string => {
  const lower = name.toLowerCase();
  if (lower === "bash" || lower === "powershell") {
    const raw = (args.command ?? args.description ?? "") as string;
    const cmd = compressBash(raw);
    return `* ${name} "${cmd}"`;
  }
  if (lower === "grep" || lower === "find") {
    const pattern = typeof args.pattern === "string" ? args.pattern : typeof args.query === "string" ? args.query : "";
    const path = extractPath(args);
    if (pattern && path) return `* ${name} "${pattern}" in ${path}`;
    if (pattern) return `* ${name} "${pattern}"`;
    if (path) return `* ${name} in ${path}`;
    return `* ${name}`;
  }
  const field = TOOL_SUMMARY_FIELDS[lower];
  if (field && typeof args[field] === "string") {
    return `* ${name} "${args[field] as string}"`;
  }
  const path = extractPath(args);
  if (path) return `* ${name} "${path}"`;
  if (typeof args.query === "string") {
    return `* ${name} "${clip(args.query as string, 60)}"`;
  }
  return `* ${name}`;
};

export interface BriefLine {
  /** Section header like "[user]" or "[assistant]" */
  header: string;
  /** Content lines for this section */
  lines: string[];
}

/**
 * Build BriefLine sections from NormalizedBlocks.
 */
export const buildBriefSections = (blocks: NormalizedBlock[]): BriefLine[] => {
  const sections: BriefLine[] = [];
  let lastHeader = "";

  const push = (header: string, line: string) => {
    if (header === lastHeader && sections.length > 0) {
      sections[sections.length - 1].lines.push(line);
      return;
    }
    sections.push({ header, lines: [line] });
    lastHeader = header;
  };

  const pushText = (header: string, text: string, ref = "") => {
    const lines = text.split("\n");
    if (ref && lines.length > 0) {
      lines[lines.length - 1] = `${lines[lines.length - 1]}${ref}`;
    }
    for (const line of lines) push(header, line);
  };

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const b = blocks[blockIndex];
    switch (b.kind) {
      case "user": {
        if (isNoiseUser(b.text)) break;
        const text = truncateTokens(collapseSkillText(b.text), TRUNCATE_USER);
        if (text) {
          const ref = b.sourceIndex != null ? ` (#${b.sourceIndex})` : "";
          pushText("[user]", text, ref);
        }
        lastHeader = "[user]";
        break;
      }
      case "bash": {
        const cmd = compressBash(b.command);
        const ref = b.sourceIndex != null ? ` (#${b.sourceIndex})` : "";
        if (cmd) {
          push("[user]", `$ ${cmd}${ref}`);
        }
        lastHeader = "[user]";
        break;
      }
      case "custom": {
        const text = truncateTokens(b.text, TRUNCATE_USER);
        if (text) {
          pushText(`[ext:${b.customType}]`, text);
        }
        lastHeader = `[ext:${b.customType}]`;
        break;
      }
      case "branch_summary": {
        const text = truncateTokens(b.text, TRUNCATE_USER);
        if (text) {
          pushText("[branch summary]", text);
        }
        lastHeader = "[branch summary]";
        break;
      }
      case "assistant": {
        let raw = b.text;
        // Strip leading self-talk prefix (up to 2x; assistants sometimes chain "Hmm, actually, ...")
        for (let i = 0; i < 2; i++) {
          const stripped = raw.replace(SELF_TALK_PREFIX_RE, "");
          if (stripped === raw) break;
          raw = stripped;
        }
        const text = isSegmentClosingAssistant(blocks, blockIndex)
          ? truncateTokensHeadTail(raw, SEGMENT_CLOSING_ASSISTANT_HEAD_WORDS, SEGMENT_CLOSING_ASSISTANT_TAIL_WORDS)
          : truncateTokensHeadTail(raw, ASSISTANT_HEAD_WORDS, ASSISTANT_TAIL_WORDS);
        if (text) {
          const ref = b.sourceIndex != null ? ` (#${b.sourceIndex})` : "";
          pushText("[assistant]", text, ref);
        }
        break;
      }
      case "tool_call": {
        // Skip malformed tool calls from streaming providers (empty name / fragmented args).
        if (!b.name || b.name.trim() === "") break;
        const ref = b.sourceIndex != null ? ` (#${b.sourceIndex})` : "";
        const summary = toolOneLiner(b.name, b.args) + ref;
        push("[assistant]", summary);
        break;
      }
      case "tool_result":
        // Tool result bodies are intentionally omitted from compact briefs.
        break;
    }
  }

  // Collapse consecutive identical tool lines (same text, different #ref)
  for (const sec of sections) {
    if (sec.header !== "[assistant]") continue;
    const out: string[] = [];
    for (const line of sec.lines) {
      if (!line.startsWith("* ")) { out.push(line); continue; }
      const ref = line.match(/\(#(\d+)\)$/)?.[1] ?? "";
      const base = ref ? line.slice(0, -(ref.length + 3)).trimEnd() : line;
      const last = out.length > 0 ? out[out.length - 1] : "";
      const m = last.match(/^(.*) \((#[\d, #]+)\) x(\d+)$/);
      if (m && m[1] === base) {
        out[out.length - 1] = `${base} (${m[2]}, #${ref}) x${parseInt(m[3]) + 1}`;
      } else if (last.match(/\(#\d+\)$/) && last.replace(/\s*\(#\d+\)$/, "") === base) {
        const prevRef = last.match(/\(#(\d+)\)$/)?.[1];
        out[out.length - 1] = `${base} (#${prevRef}, #${ref}) x2`;
      } else {
        out.push(line);
      }
    }
    sec.lines = out;
  }

  // Cap tool calls per [assistant] turn — keep tail (latest actions tend to
  // be the deciding edits/writes; head is usually exploration noise).
  const TOOL_CALLS_PER_TURN = 8;
  for (const sec of sections) {
    if (sec.header !== "[assistant]") continue;
    const toolIdxs = sec.lines
      .map((l, i) => (l.startsWith("* ") ? i : -1))
      .filter((i) => i >= 0);
    if (toolIdxs.length <= TOOL_CALLS_PER_TURN) continue;
    const dropCount = toolIdxs.length - TOOL_CALLS_PER_TURN;
    const dropSet = new Set(toolIdxs.slice(0, dropCount));
    const firstKeptToolIdx = toolIdxs[dropCount];
    const next: string[] = [];
    let inserted = false;
    for (let i = 0; i < sec.lines.length; i++) {
      if (dropSet.has(i)) continue;
      if (!inserted && i === firstKeptToolIdx) {
        next.push(`* (${dropCount} earlier tool-call entries omitted)`);
        inserted = true;
      }
      next.push(sec.lines[i]);
    }
    sec.lines = next;
  }

  return sections;
};

/**
 * Stringify BriefLine sections into text format.
 */
export const stringifyBrief = (sections: BriefLine[]): string => {

  // Emit sections -- suppress blank lines between consecutive tool summaries
  const out: string[] = [];
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    if (i > 0) {
      const prev = sections[i - 1];
      const prevIsTools = prev.header === "[assistant]" &&
        prev.lines.every((l) => l.startsWith("* "));
      const curIsTools = sec.header === "[assistant]" &&
        sec.lines.every((l) => l.startsWith("* "));
      if (!(prevIsTools && curIsTools)) {
        out.push("");
      }
    }
    out.push(sec.header);
    for (const line of sec.lines) {
      out.push(line);
    }
  }

  return out.join("\n");
};

const shortenPath = (p: string): string => {
  const parts = p.split(/[/\\]/);
  return parts.length > 2 ? parts.slice(-2).join("/") : p;
};

// ── causal extraction ──

const CAUSE_MARKERS: readonly string[] = [
  "the issue is",
  "the problem is",
  "the problem was",
  "the bug is",
  "the bug was",
  "the cause is",
  "root cause:",
  "root cause is",
  "the reason is",
  "fails because",
  "fails when",
  "fails due to",
  "crashes because",
  "crashes when",
  "crashes due to",
  "breaks because",
  "breaks when",
  "breaks due to",
  "because ",
  "since ",
  "due to ",
  "missing ",
  "lacking ",
  "lack of ",
  "absence of ",
  "can't ",
  "cannot ",
  "not properly ",
  "not correctly ",
  "not validating ",
  "not returning ",
  "not handling ",
  "not releasing ",
  "not checking ",
  "wrong ",
  "incorrect ",
  "stale ",
  "outdated ",
  "unhandled ",
  "uncaught ",
];

const RESOLUTION_MARKERS: readonly string[] = [
  "fix this by",
  "fix it by",
  "resolve this by",
  "resolve it by",
  "resolve by",
  "handle this by",
  "handle by",
  "address this by",
  "address by",
  "by adding",
  "by creating",
  "by implementing",
  "by introducing",
  "by applying",
  "by inserting",
  "by using",
  "by swapping",
  "by migrating",
  "by isolating",
  "by splitting",
  "by extracting",
  "by replacing",
  "by refactoring",
  "by wrapping",
  "by moving",
  "by removing",
  "added ",
  "created ",
  "implemented ",
  "introduced ",
  "applied ",
  "inserted ",
  "changed to",
  "updated to",
  "switched to",
  "migrated to",
  "replaced with",
  "replaced by",
  "refactored to",
  "extracted into",
  "set up ",
  "configured ",
  "enabled ",
  "swapped ",
  "isolated ",
  "splitting ",
  "split ",
  "wrapped ",
  "guarded ",
  "moved ",
  "removed ",
];

const FRAGMENT_MAX = 60;
const CAUSAL_BREADCRUMB_MAX = 40;
const SENTINEL_CHARS = new Set([",", ".", ";", "!", "?", "\n"]);

const extractFragment = (
  text: string,
  markers: readonly string[],
): string | null => {
  const lower = text.toLowerCase();
  for (const marker of markers) {
    const idx = lower.indexOf(marker);
    if (idx < 0) continue;
    const start = idx + marker.length;
    if (start >= text.length) continue;

    let end = start;
    while (end < text.length && end - start < FRAGMENT_MAX) {
      if (SENTINEL_CHARS.has(text[end])) break;
      end++;
    }
    const fragment = text.slice(start, end).trim();
    if (fragment.length < 4) continue;
    return fragment;
  }
  return null;
};

export const extractCausalChain = (
  text: string,
): { cause: string | null; resolution: string | null } => {
  let cause = extractFragment(text, CAUSE_MARKERS);
  let resolution = extractFragment(text, RESOLUTION_MARKERS);

  if (!cause || !resolution) {
    const sentences = text.split(/[.!?]/).filter((s) => s.trim().length > 3);
    for (const sentence of sentences) {
      if (!cause) cause = extractFragment(sentence, CAUSE_MARKERS);
      if (!resolution) resolution = extractFragment(sentence, RESOLUTION_MARKERS);
      if (cause && resolution) break;
    }
  }

  return {
    cause: cause ? clip(cause, CAUSAL_BREADCRUMB_MAX) : null,
    resolution: resolution ? clip(resolution, CAUSAL_BREADCRUMB_MAX) : null,
  };
};

const synthesizeTurnSummary = (
  userText: string | null,
  toolActions: string[],
  causalChain: { cause: string | null; resolution: string | null } = { cause: null, resolution: null },
): string => {
  const parts: string[] = [];

  if (userText && userText.length > 3) {
    parts.push(clip(userText, 50));
  }

  const hasCausal = causalChain.cause || causalChain.resolution;
  if (hasCausal) {
    if (causalChain.cause) parts.push(causalChain.cause);
    if (causalChain.resolution) parts.push(causalChain.resolution);
  }

  const uniqueActions = [...new Set(toolActions)].slice(0, 5);
  if (uniqueActions.length > 0) {
    const edits = uniqueActions.filter((a) => a.startsWith("edited"));
    const others = uniqueActions.filter((a) => !a.startsWith("edited"));
    if (edits.length > 0 && others.length <= 2) {
      parts.push(uniqueActions.join(", "));
    } else if (edits.length > 0) {
      parts.push(edits.join(", "));
      if (others.length > 0) parts.push(`+${others.length} more`);
    } else {
      parts.push(uniqueActions.join(", "));
    }
  }

  return parts.join(" \u2192 ") || "(no actions)";
};

export interface TurnInfo {
  summary: string;
}

export const identifyTurns = (blocks: NormalizedBlock[]): TurnInfo[] => {
  const turns: TurnInfo[] = [];
  let currentUserText: string | null = null;
  const toolActions: string[] = [];
  const assistantTexts: string[] = [];

  const flush = () => {
    if (currentUserText === null && toolActions.length === 0) return;

    const combinedAssistant = assistantTexts.join(" ");
    const causalChain = extractCausalChain(combinedAssistant);

    turns.push({
      summary: synthesizeTurnSummary(currentUserText, toolActions, causalChain),
    });
    currentUserText = null;
    toolActions.length = 0;
    assistantTexts.length = 0;
  };

  for (const b of blocks) {
    if (b.kind === "user" || b.kind === "bash") {
      flush();
      currentUserText = b.kind === "user"
        ? truncateTokens(collapseSkillText(b.text), 12)
        : truncateTokens(b.command, 12);
    } else if (b.kind === "assistant") {
      if (b.text) assistantTexts.push(b.text);
    } else if (b.kind === "tool_call") {
      const path = extractPath(b.args);
      const name = b.name.toLowerCase();
      if (path) {
        const short = shortenPath(path);
        if (name === "edit" || name === "write" || name === "multiedit") {
          toolActions.push(`edited ${short}`);
        } else if (name === "read") {
          toolActions.push(`read ${short}`);
        } else {
          toolActions.push(`${name} ${short}`);
        }
      } else if (name === "bash") {
        const cmd = (b.args.command ?? "") as string;
        const first = cmd.split("\n")[0]?.slice(0, 30) ?? "cmd";
        toolActions.push(`ran ${first}`);
      } else {
        toolActions.push(name);
      }
    }
  }
  flush();
  return turns;
};

/** Convenience: build sections from blocks and stringify to text */
export const compileBrief = (blocks: NormalizedBlock[]): string =>
  stringifyBrief(buildBriefSections(blocks));

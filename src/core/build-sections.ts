import type { FileOps, NormalizedBlock } from "../types";
import { clip, clipSentence, firstLine, nonEmptyLines } from "./content";
import { extractPath } from "./tool-args";
import type { SectionData } from "../sections";
import { extractGoals } from "../extract/goals";
import { extractFiles, trimFileActivityCommonPrefix } from "../extract/files";
import { extractPreferences, dedupPreferencesAgainstGoals } from "../extract/preferences";
import { extractCommits, formatCommits } from "../extract/commits";
import { buildBriefSections, stringifyBrief } from "./brief";

export interface BuildSectionsInput {
  blocks: NormalizedBlock[];
  briefBlocks?: NormalizedBlock[];
  /** Hook-provided file activity; authoritative for files touched before this compaction. */
  fileOps?: FileOps;
}

const BLOCKER_RE =
  /\b(fail(ed|s|ure|ing)?|broken|cannot|can't|won't work|does not work|doesn't work|still (broken|failing|wrong)|blocked|blocker|not (fixed|resolved|working)|crash(es|ed|ing)?)\b/i;

// TypeScript compiler error pattern
const TSC_ERROR_RE = /error TS\d+:.+/;

// Test failure indicators
const TEST_FAIL_RE = /(?:FAIL|✗|✘|×)\s|(\d+)\s+(?:failed|failure|failing)/i;

// Empty grep/search result indicators
const EMPTY_RESULT_RE = /^(?:No matches? found\.?|No files? matched\.?|0 results?|No results?\.?)$/i;

// Maximum characters of bash output to scan for error patterns.
const BASH_OUTPUT_SCAN_LIMIT = 8_000;

// Priority tags for outstanding context items
const PRIORITY_ERROR = "[ERROR]";
const PRIORITY_WARN = "[WARN]";
const PRIORITY_INFO = "[INFO]";

/** Prepend a priority tag based on the error type and exit code. */
const priorityTag = (item: string): string => {
  if (/^\[tsc\]/.test(item)) return `${PRIORITY_ERROR} ${item}`;
  if (/^\[bash:exit [1-9]\d*\]/.test(item)) return `${PRIORITY_ERROR} ${item}`;
  if (/^\[tests\]/.test(item)) return `${PRIORITY_WARN} ${item}`;
  if (/^\[no matches\]/.test(item)) return `${PRIORITY_INFO} ${item}`;
  if (/^\[user\]/.test(item)) return `${PRIORITY_WARN} ${item}`;
  // Generic tool errors
  if (/^\[\w+\]/.test(item)) return `${PRIORITY_ERROR} ${item}`;
  return `${PRIORITY_WARN} ${item}`;
};

// Write-tool names used for resolution detection
const FILE_EDIT_TOOLS = new Set([
  "edit", "write", "multiedit",
]);

/** Extract file path from a [tsc] error line like "src/auth.ts(5,18): error TS2304: ..." */
const extractTscFile = (item: string): string | null => {
  const m = item.match(/^\[tsc\]\s+(\S+)\(\d+,\d+\)/);
  return m ? m[1] : null;
};

/** Check if a tsc error's file was edited at a position after the error. */
const isTscResolved = (file: string, tailIdx: number, editPositions: Map<number, Set<string>>): boolean => {
  for (const [pos, files] of editPositions) {
    if (pos > tailIdx && files.has(file)) return true;
  }
  return false;
};

const extractOutstandingContext = (blocks: NormalizedBlock[]): string[] => {
  const items: string[] = [];
  const itemTailIndices: number[] = [];
  const seen = new Set<string>();
  const tail = blocks.slice(-25);

  const push = (item: string, tailIndex?: number) => {
    if (!seen.has(item)) {
      seen.add(item);
      items.push(item);
      itemTailIndices.push(tailIndex ?? -1);
    }
  };

  for (let bi = 0; bi < tail.length; bi++) {
    const b = tail[bi];

    // 1. Bash: check for compiler/test failures before generic exit-code fallback
    if (b.kind === "bash") {
      const outputHead = b.output ? b.output.slice(0, BASH_OUTPUT_SCAN_LIMIT) : "";
      if (outputHead && TSC_ERROR_RE.test(outputHead)) {
        const tsLines = outputHead
          .split("\n")
          .filter((l) => TSC_ERROR_RE.test(l.trim()))
          .slice(0, 3);
        for (const line of tsLines) {
          push(`[tsc] ${clip(line.trim(), 150)}`, bi);
        }
        continue;
      }
      if (outputHead && TEST_FAIL_RE.test(outputHead)) {
        push(`[tests] ${firstLine(b.output, 150)}`);
        continue;
      }
      if (b.exitCode !== undefined && b.exitCode !== 0) {
        const cmd = b.command.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? b.command;
        const cmdDisplay = cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd;
        const outLine = firstLine(b.output, 120);
        const errTag = `exit ${b.exitCode}`;
        push(`[bash:${errTag}] ${cmdDisplay}${outLine && outLine !== cmdDisplay ? ` → ${outLine}` : ""}`);
        continue;
      }
    }

    // 2. Empty grep/search results (searched for something that wasn't found = signal)
    if (b.kind === "tool_result" && b.name) {
      const toolNameLower = b.name.toLowerCase();
      if (toolNameLower === "grep" || toolNameLower === "glob") {
        const trimmed = b.text.trim();
        if (EMPTY_RESULT_RE.test(trimmed) || trimmed === "") {
          const prevIdx = tail.slice(0, bi).findLastIndex(
            (p) => p.kind === "tool_call" && Boolean(p.name && p.name.toLowerCase() === toolNameLower),
          );
          let pattern = "";
          if (prevIdx >= 0) {
            const pc = tail[prevIdx];
            if (pc.kind === "tool_call") {
              pattern = (pc.args.pattern ?? pc.args.query ?? pc.args.glob ?? "") as string;
              if (pattern) pattern = ` "${clip(pattern, 60)}"`;
            }
          }
          push(`[no matches] ${b.name}${pattern}`);
          continue;
        }
      }
    }

    // 3. Tool errors — classify tsc/test failures before generic catch
    if (b.kind === "tool_result" && b.isError) {
      const textHead = b.text.slice(0, BASH_OUTPUT_SCAN_LIMIT);
      // Check for tsc errors in tool result text first
      if (TSC_ERROR_RE.test(textHead)) {
        const tsLines = textHead
          .split("\n")
          .filter((l) => TSC_ERROR_RE.test(l.trim()))
          .slice(0, 3);
        for (const line of tsLines) {
          push(`[tsc] ${clip(line.trim(), 150)}`, bi);
        }
        continue;
      }
      // Check for test failures
      if (TEST_FAIL_RE.test(textHead)) {
        push(`[tests] ${firstLine(b.text, 150)}`);
        continue;
      }
      // Generic error fallback
      const toolLabel = b.name ? b.name : "tool";
      push(`[${toolLabel}] ${firstLine(b.text, 150)}`);
      continue;
    }

    // 4. BLOCKER_RE text matching (user/assistant mentions of problems)
    if (b.kind === "assistant" || b.kind === "user") {
      for (const line of nonEmptyLines(b.text)) {
        if (!BLOCKER_RE.test(line)) continue;
        if (line.length < 15) continue;
        // Skip continuation fragments (sub-bullets, parentheticals, dangling clauses)
        if (/^\s*[-*+>]\s/.test(line)) continue;
        if (/^\s*\(/.test(line)) continue;
        // Require sentence-like start: capital letter, code identifier, or quote
        if (!/^\s*["'`*_]?[A-Z`]/.test(line)) continue;
        const clipped = b.kind === "user" ? `[user] ${clipSentence(line, 150)}` : clipSentence(line, 150);
        push(clipped);
        break;
      }
    }
  }

  // Resolution detection: pre-compute edit positions in the tail so we can
  // check whether tsc errors were subsequently fixed by an edit to the same file.
  const editPositions = new Map<number, Set<string>>();
  for (let i = 0; i < tail.length; i++) {
    const b = tail[i];
    if (b.kind === "tool_call" && b.name && FILE_EDIT_TOOLS.has(b.name.toLowerCase())) {
      const path = extractPath(b.args);
      if (path) {
        if (!editPositions.has(i)) editPositions.set(i, new Set());
        editPositions.get(i)!.add(path);
      }
    }
  }

  // Apply priority tags, marking resolved tsc errors as [RESOLVED]
  return items.slice(0, 8).map((item, idx) => {
    const tailIdx = itemTailIndices[idx] ?? -1;
    const file = extractTscFile(item);
    const resolved = tailIdx >= 0 && file !== null && isTscResolved(file, tailIdx, editPositions);
    if (!resolved) return priorityTag(item);
    const tagged = priorityTag(item);
    return tagged.replace(/^\[(ERROR|WARN)\]/, "[RESOLVED]");
  });
};

const formatFileActivity = (blocks: NormalizedBlock[], fileOps?: FileOps): string[] => {
  const rawAct = extractFiles(blocks, fileOps);
  const act = trimFileActivityCommonPrefix(rawAct);
  // Dedup: if already Modified, drop from Created (file existed before)
  for (const p of act.modified) act.created.delete(p);
  const lines: string[] = [];
  const cap = (set: Set<string>, limit: number) => {
    const arr = [...set];
    if (arr.length <= limit) return arr.join(", ");
    return arr.slice(0, limit).join(", ") + ` (+${arr.length - limit} more)`;
  };
  if (act.modified.size > 0) lines.push(`Modified: ${cap(act.modified, 10)}`);
  if (act.created.size > 0) lines.push(`Created: ${cap(act.created, 10)}`);
  if (act.read.size > 0) lines.push(`Read: ${cap(act.read, 10)}`);
  return lines;
};

export const buildSections = (input: BuildSectionsInput): SectionData => {
  const { blocks } = input;
  const briefSections = buildBriefSections(input.briefBlocks ?? blocks);
  const sessionGoal = extractGoals(blocks);
  const userPreferences = dedupPreferencesAgainstGoals(
    extractPreferences(blocks),
    sessionGoal,
  );
  return {
    sessionGoal,
    outstandingContext: extractOutstandingContext(blocks),
    filesAndChanges: formatFileActivity(blocks, input.fileOps),
    commits: formatCommits(extractCommits(blocks)),
    userPreferences,
    briefTranscript: stringifyBrief(briefSections),
  };
};

import type { FileOps, NormalizedBlock, ToolResultIndex } from "../types";
import { clip, clipSentence, firstLine, nonEmptyLines } from "./content";
import { extractPath } from "./tool-args";
import type { SectionData } from "../sections";
import { extractGoals } from "../extract/goals";
import { trimFileActivityCommonPrefix } from "../extract/files";
import { extractFileAndSymbolData, type UnifiedExtractResult } from "../extract/shared-symbols";
import { extractPreferences, dedupPreferencesAgainstGoals } from "../extract/preferences";
import { extractCommits, formatCommits } from "../extract/commits";
import { buildBriefSections, identifyTurns, stringifyBrief } from "./brief";

export interface BuildSectionsInput {
  blocks: NormalizedBlock[];
  briefBlocks?: NormalizedBlock[];
  /** Hook-provided file activity; authoritative for files touched before this compaction. */
  fileOps?: FileOps;
  toolResultIndex?: ToolResultIndex;
}

const BLOCKER_RE =
  /\b(fail(ed|s|ure|ing)?|broken|cannot|can't|won't work|does not work|doesn't work|still (broken|failing|wrong)|blocked|blocker|not (fixed|resolved|working)|crash(es|ed|ing)?)\b/i;

// TypeScript compiler error pattern
const TSC_ERROR_RE = /error TS\d+:.+/;

// Test failure indicators. Keep the uppercase FAIL marker case-sensitive so
// successful summaries such as "0 fail" do not match.
const TEST_FAIL_RE = /FAIL\s|[✗✘×]\s|(?:[1-9]\d*)\s+(?:failed|failure|failing)\b/;
const TEST_FAIL_COUNT_RE = /(?:[1-9]\d*)\s+(?:failed|failure|failing)\b/i;

const testFailureLine = (text: string): string | null => {
  for (const line of text.split("\n")) {
    if (TEST_FAIL_RE.test(line) || TEST_FAIL_COUNT_RE.test(line)) return line.trim();
  }
  return null;
};

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
      const failedTestLine = b.exitCode !== 0 ? testFailureLine(outputHead) : null;
      if (failedTestLine) {
        push(`[tests] ${clip(failedTestLine, 150)}`);
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
      const failedTestLine = testFailureLine(textHead);
      if (failedTestLine) {
        push(`[tests] ${clip(failedTestLine, 150)}`);
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

const buildToolResultIndex = (blocks: NormalizedBlock[]): ToolResultIndex => {
  const map = new Map<number, Extract<NormalizedBlock, { kind: "tool_result" }>>();
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].kind !== "tool_call") continue;
    for (let j = i + 1; j < Math.min(blocks.length, i + 4); j++) {
      if (blocks[j].kind === "tool_result") {
        map.set(i, blocks[j] as Extract<NormalizedBlock, { kind: "tool_result" }>);
        break;
      }
    }
  }
  return {
    get: (callIndex: number) => map.get(callIndex) ?? null,
  };
};

const formatFileActivityFromUnified = (data: UnifiedExtractResult): string[] => {
  const act = trimFileActivityCommonPrefix(data.fileActivity);
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

const formatTypeCatalogFromUnified = (data: UnifiedExtractResult): string[] => {
  const catalog = data.typeCatalog;
  if (catalog.length === 0) return [];
  const lines: string[] = [];
  let totalSigs = 0;
  const MAX_TOTAL_SIGS = 30;

  const omittedFiles: string[] = [];
  for (let i = 0; i < catalog.length; i++) {
    const entry = catalog[i];
    if (totalSigs >= MAX_TOTAL_SIGS) {
      omittedFiles.push(entry.file);
      continue;
    }
    lines.push(`${entry.file}:`);
    for (const sig of entry.signatures) {
      if (totalSigs >= MAX_TOTAL_SIGS) break;
      lines.push(`  ${sig}`);
      totalSigs++;
    }
  }
  if (omittedFiles.length > 0) {
    lines.push(`(${omittedFiles.length} more files with signatures omitted)`);
  }

  return lines;
};

export const buildSections = (input: BuildSectionsInput): SectionData => {
  const { blocks } = input;
  const tri = input.toolResultIndex ?? buildToolResultIndex(blocks);
  const fileAndSymbols = extractFileAndSymbolData(blocks, tri, input.fileOps);
  const briefSections = buildBriefSections(input.briefBlocks ?? blocks);
  const sessionGoal = extractGoals(blocks);
  const userPreferences = dedupPreferencesAgainstGoals(
    extractPreferences(blocks),
    sessionGoal,
  );
  return {
    sessionGoal,
    outstandingContext: extractOutstandingContext(blocks),
    filesAndChanges: formatFileActivityFromUnified(fileAndSymbols),
    commits: formatCommits(extractCommits(blocks)),
    userPreferences,
    typeCatalog: formatTypeCatalogFromUnified(fileAndSymbols),
    symbolChanges: fileAndSymbols.symbolChanges,
    turnSummaries: identifyTurns(blocks).map((t) => t.summary),
    briefTranscript: stringifyBrief(briefSections),
  };
};

import type { FileOps, NormalizedBlock } from "../types";
import { extractPath } from "../core/tool-args";

export interface FileActivity {
  read: Set<string>;
  modified: Set<string>;
  created: Set<string>;
}

// Tool names are matched case-insensitively (see `matches`), mirroring the /i
// regexes in core/rank.ts. Entries must be lowercase.
const FILE_READ_TOOLS = new Set([
  "read", "read_file", "view",
]);

// Multi-file patch tools (apply_patch) carry their paths inside the diff payload,
// not in a path arg, so extractPath yields nothing for them; those files are
// recovered from the hook-provided fileOps below.
const FILE_WRITE_TOOLS = new Set([
  "edit", "write", "edit_file", "write_file",
  "multiedit", "quick_edit", "target_edit", "apply_patch",
]);

const FILE_CREATE_TOOLS = new Set([
  "write", "write_file",
]);

const matches = (tools: Set<string>, name: string): boolean => tools.has(name.toLowerCase());

/**
 * Find the longest common directory prefix among absolute paths.
 * Returns "" if fewer than 2 absolute paths or no meaningful common prefix.
 */
export const longestCommonDirPrefix = (paths: string[]): string => {
  const abs = paths.filter((p) => p.startsWith("/"));
  if (abs.length < 2) return "";
  const split = abs.map((p) => p.split("/"));
  const min = Math.min(...split.map((s) => s.length));
  let i = 0;
  while (i < min - 1) {
    const seg = split[0][i];
    if (!split.every((s) => s[i] === seg)) break;
    i++;
  }
  if (i < 2) return ""; // require at least /a/b common
  return split[0].slice(0, i).join("/") + "/";
};

const trimPaths = (set: Set<string>, prefix: string): Set<string> => {
  if (!prefix) return set;
  const out = new Set<string>();
  for (const p of set) {
    out.add(p.startsWith(prefix) ? p.slice(prefix.length) : p);
  }
  return out;
};

export const trimFileActivityCommonPrefix = (act: FileActivity): FileActivity => {
  const all = [...act.read, ...act.modified, ...act.created];
  const prefix = longestCommonDirPrefix(all);
  if (!prefix) return act;
  return {
    read: trimPaths(act.read, prefix),
    modified: trimPaths(act.modified, prefix),
    created: trimPaths(act.created, prefix),
  };
};

const REDIRECT_RE = /(?:>>?|tee(?:\s+-[a-zA-Z]+)*)\s+([^\s;&|<>]+)/g;

const extractRedirectTargets = (cmd: string): string[] => {
  const targets: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = REDIRECT_RE.exec(cmd)) !== null) {
    const target = m[1]?.trim();
    if (target && !target.startsWith("&") && target !== "/dev/null") {
      targets.push(target);
    }
  }
  return targets;
};

export const extractFiles = (
  blocks: NormalizedBlock[],
  fileOps?: FileOps,
): FileActivity => {
  const act: FileActivity = {
    read: new Set(fileOps?.readFiles ?? []),
    modified: new Set(fileOps?.modifiedFiles ?? []),
    created: new Set(fileOps?.createdFiles ?? []),
  };

  for (const b of blocks) {
    if (b.kind === "tool_call") {
      const p = extractPath(b.args);
      if (p) {
        if (matches(FILE_READ_TOOLS, b.name)) act.read.add(p);
        if (matches(FILE_WRITE_TOOLS, b.name)) act.modified.add(p);
        if (matches(FILE_CREATE_TOOLS, b.name)) act.created.add(p);
      }
      if (/^(bash|powershell)$/i.test(b.name) && typeof b.args.command === "string") {
        for (const t of extractRedirectTargets(b.args.command)) {
          act.modified.add(t);
        }
      }
    } else if (b.kind === "bash") {
      for (const t of extractRedirectTargets(b.command)) {
        act.modified.add(t);
      }
    }
  }

  return act;
};

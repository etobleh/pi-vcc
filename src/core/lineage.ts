export interface LineageEntryLike {
  id?: string;
}

export interface LineageSessionManagerLike {
  getBranch: () => LineageEntryLike[];
  getEntries?: () => LineageEntryLike[];
}

export const getActiveLineageEntryIds = (sessionManager: LineageSessionManagerLike): Set<string> => {
  try {
    const branch = sessionManager.getBranch() ?? [];
    if (branch.length > 0) {
      return new Set(branch.map((e) => e.id).filter((id): id is string => Boolean(id)));
    }
  } catch {
    // fall through to defensive fallback
  }

  try {
    const all = sessionManager.getEntries?.() ?? [];
    return new Set(all.map((e) => e.id).filter((id): id is string => Boolean(id)));
  } catch {
    return new Set();
  }
};

export const buildGlobalIndexMap = (entries: any[]): Map<string, number> => {
  const map = new Map<string, number>();
  let messageIndex = 0;
  for (const e of entries) {
    if (e && e.type === "message" && e.message) {
      if (e.id) {
        map.set(e.id, messageIndex);
      }
      messageIndex++;
    }
  }
  return map;
};

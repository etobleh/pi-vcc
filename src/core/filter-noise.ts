import type { NormalizedBlock } from "../types";

export const DEFAULT_NOISE_TOOLS = new Set([
  "vcc_recall",
]);

export const DEFAULT_NOISE_CUSTOM_TYPES = new Set([
  "vcc-recall",
  "pi-vcc-auto-continue",
]);

export interface FilterNoiseOptions {
  extraNoiseTools?: string[];
  extraNoiseCustomTypes?: string[];
}

export const filterNoise = (
  blocks: NormalizedBlock[],
  options: FilterNoiseOptions = {},
): NormalizedBlock[] => {
  const noiseTools = new Set([
    ...DEFAULT_NOISE_TOOLS,
    ...(options.extraNoiseTools ?? []).map((t) => t.toLowerCase()),
  ]);
  const noiseCustomTypes = new Set([
    ...DEFAULT_NOISE_CUSTOM_TYPES,
    ...(options.extraNoiseCustomTypes ?? []).map((t) => t.toLowerCase()),
  ]);

  const out: NormalizedBlock[] = [];
  for (const b of blocks) {
    if (b.kind === "thinking") continue;
    if (b.kind === "tool_call" && b.name && noiseTools.has(b.name.toLowerCase())) continue;
    if (b.kind === "tool_result" && b.name && noiseTools.has(b.name.toLowerCase())) continue;
    if (b.kind === "custom" && b.customType && noiseCustomTypes.has(b.customType.toLowerCase())) continue;
    if (b.kind === "user") {
      const trimmed = b.text.trim();
      if (!trimmed) continue;
      out.push({ kind: "user", text: trimmed, sourceIndex: b.sourceIndex });
      continue;
    }
    out.push(b);
  }
  return out;
};

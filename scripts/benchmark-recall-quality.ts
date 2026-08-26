/**
 * Phase 2 (vcc_recall noise floor + hard cap) constant selection evidence.
 *
 * Runs the REAL production `searchEntriesDetailed` (via its bench-only
 * `tuning` override) against real session transcripts, comparing candidate
 * relative-floor and hard-cap values. Not a duplicate scoring
 * implementation — this exercises the exact code path that ships.
 *
 * Production policy baked into `searchEntriesDetailed` itself (not
 * controlled by `tuning`): the relative floor only applies when the query
 * has >=2 effective terms after stopword filtering. Single-term runs below
 * therefore show identical counts across every floor candidate — that's the
 * policy working, not a bug in this script.
 *
 * Usage: bun run scripts/benchmark-recall-quality.ts [sessionCount]
 */
import { renderMessage } from "../src/core/render-entries";
import { searchEntriesDetailed, type SearchHit } from "../src/core/search-entries";
import { prepareSessionSamples } from "../tests/support/real-sessions";
import { loadSessionMessages } from "../tests/support/load-session";

// Inlined (not imported from research/audit/metrics.ts) so this script has
// no dependency on the gitignored research/ tree and stays reproducible from
// a plain checkout.
const quantile = (values: number[], q: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (pos - lower);
};
const median = (values: number[]): number => quantile(values, 0.5);

const SESSION_COUNT = Number(process.argv[2] ?? 25);

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "of", "in", "to", "for",
  "with", "on", "at", "from", "by", "as", "into", "through", "and", "that",
  "this", "what", "which", "who", "you", "your", "i", "we", "it", "its",
]);

interface Query {
  session: string;
  kind: "single" | "multi";
  text: string;
}

/** Pull candidate queries out of a session's own content — no synthetic corpus. */
const queriesOf = (label: string, messages: ReturnType<typeof loadSessionMessages>["messages"]): Query[] => {
  const words = new Set<string>();
  const phrases: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const content = msg.content;
    if (typeof content !== "string" && !Array.isArray(content)) continue;
    const text = typeof content === "string"
      ? content
      : content.filter((p: any) => p.type === "text").map((p: any) => p.text).join(" ");
    if (!text) continue;
    const tokens = text.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? [];
    const meaningful = tokens.filter((t) => !STOPWORDS.has(t));
    for (const t of meaningful.slice(0, 6)) words.add(t);
    if (msg.role === "user" && meaningful.length >= 2) {
      phrases.push(meaningful.slice(0, 4).join(" "));
    }
  }
  const singles = [...words].slice(0, 4).map((text): Query => ({ session: label, kind: "single", text }));
  const multis = phrases.slice(0, 4).map((text): Query => ({ session: label, kind: "multi", text }));
  return [...singles, ...multis];
};

interface RunResult {
  hits: SearchHit[];
  totalBeforeCap: number;
  zero: boolean;
  top1: number | undefined;
  top5: number[];
}

const run = (rendered: any[], messages: any[], q: string, tuning: { relativeFloor?: number; cap?: number }): RunResult => {
  const r = searchEntriesDetailed(rendered, messages, q, tuning);
  return {
    hits: r.hits,
    totalBeforeCap: r.totalBeforeCap,
    zero: r.hits.length === 0,
    top1: r.hits[0]?.index,
    top5: r.hits.slice(0, 5).map((h) => h.index),
  };
};

const sameArr = (a: number[], b: number[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

async function main() {
  console.log(`Sampling ${SESSION_COUNT} largest real sessions...`);
  const samples = await prepareSessionSamples(SESSION_COUNT);

  const allQueries: { label: string; rendered: any[]; messages: any[]; q: Query }[] = [];
  for (const sample of samples) {
    let loaded;
    try {
      loaded = loadSessionMessages(sample.copy);
    } catch {
      continue;
    }
    if (loaded.messages.length < 20) continue;
    const rendered = loaded.messages.map((m, i) => renderMessage(m, i));
    const label = sample.source.split("/").slice(-2).join("/");
    for (const q of queriesOf(label, loaded.messages)) {
      allQueries.push({ label, rendered, messages: loaded.messages, q });
    }
  }
  console.log(`Sessions usable: ${new Set(allQueries.map((x) => x.label)).size}, queries generated: ${allQueries.length}`);
  console.log("(counts vary with whatever real sessions happen to be available locally — treat exact numbers as one data point, not a fixed target.)");

  // ── Floor comparison (cap disabled so it isolates the floor's effect) ──
  const floorCandidates = [0, 0.1, 0.2, 0.25];
  const baselineFloor = 0;

  for (const kind of ["single", "multi"] as const) {
    console.log(`\n=== Relative floor comparison — ${kind}-term queries ===`);
    if (kind === "single") {
      console.log("  Production policy applies the floor only to queries with >=2 effective terms;");
      console.log("  for single-term queries every floor candidate below should be identical to floor=0 (no-op by design).");
    }
    const subset = allQueries.filter((x) => x.q.kind === kind);
    console.log(`  queries: ${subset.length}`);
    const baseRuns = subset.map((x) => run(x.rendered, x.messages, x.q.text, { relativeFloor: baselineFloor, cap: 1e9 }));
    for (const floor of floorCandidates) {
      const runs = subset.map((x) => run(x.rendered, x.messages, x.q.text, { relativeFloor: floor, cap: 1e9 }));
      const counts = runs.map((r) => r.hits.length);
      const baseCounts = baseRuns.map((r) => r.hits.length);
      const zeroBefore = baseRuns.filter((r) => r.zero).length;
      const zeroAfter = runs.filter((r) => r.zero).length;
      const newZero = runs.filter((r, i) => !baseRuns[i].zero && r.zero).length;
      const top1Changed = runs.filter((r, i) => baseRuns[i].top1 !== undefined && r.top1 !== baseRuns[i].top1).length;
      const top5Changed = runs.filter((r, i) => !sameArr(r.top5, baseRuns[i].top5)).length;
      console.log(
        `  floor=${floor.toFixed(2)}: median ${median(counts)} (base ${median(baseCounts)}), ` +
        `p90 ${quantile(counts, 0.9)} (base ${quantile(baseCounts, 0.9)}), ` +
        `zero-hit ${zeroAfter}/${subset.length} (base ${zeroBefore}), newly-zeroed(should be 0)=${newZero}, ` +
        `top1 changed ${top1Changed}/${subset.length}, top5 changed ${top5Changed}/${subset.length}`,
      );
    }
  }

  // ── Cap comparison (floor disabled so it isolates the cap's effect) ──
  console.log(`\n=== Hard cap comparison (all queries, floor disabled) ===`);
  const capCandidates = [1e9, 25, 50];
  console.log(`  queries: ${allQueries.length}`);
  for (const cap of capCandidates) {
    const runs = allQueries.map((x) => run(x.rendered, x.messages, x.q.text, { relativeFloor: 0, cap }));
    const counts = runs.map((r) => r.hits.length);
    const totalBefore = runs.map((r) => r.totalBeforeCap);
    console.log(
      `  cap=${cap === 1e9 ? "none" : cap}: median ${median(counts)}, p90 ${quantile(counts, 0.9)}, ` +
      `max ${Math.max(...counts)}, median-uncapped-total ${median(totalBefore)}, ` +
      `queries truncated by this cap: ${runs.filter((r) => r.totalBeforeCap > r.hits.length).length}/${allQueries.length}`,
    );
  }

  // ── Combined PRODUCTION POLICY (floor=0.20 for multi-term only, cap=50)
  //    vs raw baseline (no floor, no cap) ──
  console.log(`\n=== Combined production policy (floor=0.20 multi-term-only, cap=50) vs raw baseline ===`);
  // No script-side gating needed here: searchEntriesDetailed itself only
  // applies relativeFloor when the query has >=2 effective terms, so calling
  // it with {relativeFloor: 0.2, cap: 50} already reflects exactly what
  // ships — including the single-term no-op.
  const combined = allQueries.map((x) => run(x.rendered, x.messages, x.q.text, { relativeFloor: 0.2, cap: 50 }));
  const baseline = allQueries.map((x) => run(x.rendered, x.messages, x.q.text, { relativeFloor: 0, cap: 1e9 }));
  const zeroBefore = baseline.filter((r) => r.zero).length;
  const zeroAfter = combined.filter((r) => r.zero).length;
  const top1Changed = combined.filter((r, i) => baseline[i].top1 !== undefined && r.top1 !== baseline[i].top1).length;
  const top5Changed = combined.filter((r, i) => !sameArr(r.top5, baseline[i].top5)).length;
  console.log(`  zero-hit before: ${zeroBefore}/${allQueries.length}, after: ${zeroAfter}/${allQueries.length}`);
  console.log(`  top1 changed: ${top1Changed}/${allQueries.length}, top5 changed: ${top5Changed}/${allQueries.length}`);
  console.log(`  median result count before: ${median(baseline.map((r) => r.hits.length))}, after: ${median(combined.map((r) => r.hits.length))}`);
  console.log(`  p90 result count before: ${quantile(baseline.map((r) => r.hits.length), 0.9)}, after: ${quantile(combined.map((r) => r.hits.length), 0.9)}`);
}

main();

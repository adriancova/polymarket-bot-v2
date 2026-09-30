/**
 * `THROUGHPUT-1a` — top-N attribution of a V8 `.cpuprofile`, by SELF time and
 * by TOTAL (inclusive) time.
 *
 * A function is keyed by its name, script and line, so two closures with one
 * name stay apart. SELF time is the time a function was the sampled leaf.
 * TOTAL time counts each sample once for every DISTINCT function on its stack,
 * so recursion is not double-counted. Percentages are of the sampled time
 * (idle and GC included as V8 reports them: `(idle)`, `(garbage collector)`,
 * `(program)`).
 */

export interface CpuProfileNode {
  readonly id: number;
  readonly callFrame: {
    readonly functionName: string;
    readonly url: string;
    readonly lineNumber: number;
    readonly columnNumber: number;
  };
  readonly children?: readonly number[];
}

export interface CpuProfile {
  readonly nodes: readonly CpuProfileNode[];
  readonly startTime: number;
  readonly endTime: number;
  readonly samples: readonly number[];
  readonly timeDeltas: readonly number[];
}

export interface ProfileRow {
  readonly function: string;
  readonly ms: number;
  readonly percent: number;
}

export interface ProfileSummary {
  readonly sampledMs: number;
  readonly samples: number;
  readonly bySelf: readonly ProfileRow[];
  readonly byTotal: readonly ProfileRow[];
}

function keyOf(node: CpuProfileNode, root: string): string {
  const frame = node.callFrame;
  const name = frame.functionName === "" ? "(anonymous)" : frame.functionName;
  if (frame.url === "") return name;
  const url = frame.url.startsWith(root) ? frame.url.slice(root.length) : frame.url;
  const short = url.replace(/^file:\/\//u, "");
  return `${name} ${short}:${String(frame.lineNumber + 1)}`;
}

export function summarizeProfile(profile: CpuProfile, options: { readonly top: number; readonly root?: string }): ProfileSummary {
  const root = options.root ?? "";
  const byId = new Map<number, CpuProfileNode>();
  const parent = new Map<number, number>();
  for (const node of profile.nodes) {
    byId.set(node.id, node);
    for (const child of node.children ?? []) parent.set(child, node.id);
  }
  const self = new Map<string, number>();
  const total = new Map<string, number>();
  let sampled = 0;
  for (let index = 0; index < profile.samples.length; index += 1) {
    const nodeId = profile.samples[index];
    // The delta BEFORE sample i is the time since the previous sample; the
    // sample stands for the interval that follows it, so use the next delta.
    const deltaUs = profile.timeDeltas[index + 1] ?? profile.timeDeltas[index] ?? 0;
    if (nodeId === undefined || deltaUs <= 0) continue;
    const ms = deltaUs / 1000;
    sampled += ms;
    const leaf = byId.get(nodeId);
    if (leaf === undefined) continue;
    const leafKey = keyOf(leaf, root);
    self.set(leafKey, (self.get(leafKey) ?? 0) + ms);
    const seen = new Set<string>();
    let cursor: number | undefined = nodeId;
    while (cursor !== undefined) {
      const node = byId.get(cursor);
      if (node === undefined) break;
      const key = keyOf(node, root);
      if (!seen.has(key) && key !== "(root)") {
        seen.add(key);
        total.set(key, (total.get(key) ?? 0) + ms);
      }
      cursor = parent.get(cursor);
    }
  }
  const rows = (map: Map<string, number>): ProfileRow[] =>
    [...map.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, options.top)
      .map(([name, ms]) => ({ function: name, ms, percent: sampled === 0 ? 0 : (100 * ms) / sampled }));
  return { sampledMs: sampled, samples: profile.samples.length, bySelf: rows(self), byTotal: rows(total) };
}

export function formatProfileSummary(summary: ProfileSummary): string {
  const lines: string[] = [];
  lines.push(`sampled ${summary.sampledMs.toFixed(0)} ms over ${String(summary.samples)} samples`);
  const table = (title: string, rows: readonly ProfileRow[]): void => {
    lines.push(title);
    for (const row of rows) {
      lines.push(`  ${row.percent.toFixed(1).padStart(5)}%  ${row.ms.toFixed(0).padStart(8)} ms  ${row.function}`);
    }
  };
  table("top by SELF time:", summary.bySelf);
  table("top by TOTAL time:", summary.byTotal);
  return lines.join("\n");
}

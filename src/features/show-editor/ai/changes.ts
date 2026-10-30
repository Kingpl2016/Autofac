import { effectName } from "../lib/effectLibrary";
import type { Cue, OutputTarget, ShowProject } from "../lib/project";
import { formatTimecode } from "../lib/time";

/**
 * AI 改动的清单：比较改动前后的工程，逐项列出新增 / 删除 / 修改了什么（审阅卡片用）。
 *
 * 与撤销历史的 `describeChange` 同样依赖 immer 的结构共享（没改的对象引用不变），
 * 但这里列出每一项，而不只是“最有代表性的一类”。
 */

/** 清单里出现的对象种类。 */
export type ChangeCollection = "cues" | "groups" | "fixtures" | "sections" | "markers" | "tempo" | "output" | "duration";

/** 一项改动。 */
export interface ChangeEntry {
  collection: ChangeCollection;
  op: "added" | "removed" | "changed";
  /** 对象 id（片段被选中 / 定位用） */
  id?: string;
  /** 显示的名称 */
  label: string;
  /** 补充说明（时间范围、新旧值） */
  detail?: string;
  /** 片段起点（排序、跳转播放头用） */
  atMs?: number;
}

/** 片段的显示名：名称，或特效名，或种类。 */
function cueLabel(cue: Cue, lang: string): string {
  if ((cue.kind === "look" || cue.kind === "scene") && cue.label) return cue.label;
  if (cue.kind === "look" && cue.fx) return effectName(cue.fx.def, lang);
  return cue.kind;
}

/** 输出目标的简写。 */
function targetText(t: OutputTarget): string {
  return t.kind === "direct" ? `${t.protocol === "sacn" ? "sACN" : "Art-Net"} ${t.ip}:${t.port}` : t.kind;
}

/** 按 id 比较两个集合。 */
function diffBy<T extends { id: string }>(
  before: readonly T[],
  after: readonly T[],
  collection: ChangeCollection,
  label: (x: T) => string,
  detail?: (x: T) => string | undefined,
  at?: (x: T) => number,
): ChangeEntry[] {
  if (before === after) return [];
  const prev = new Map(before.map((x) => [x.id, x]));
  const next = new Set(after.map((x) => x.id));
  const out: ChangeEntry[] = [];
  const entry = (x: T, op: ChangeEntry["op"]): ChangeEntry => ({
    collection,
    op,
    id: x.id,
    label: label(x),
    ...(detail?.(x) ? { detail: detail(x) } : {}),
    ...(at ? { atMs: at(x) } : {}),
  });
  for (const x of after) {
    const old = prev.get(x.id);
    if (!old) out.push(entry(x, "added"));
    else if (old !== x) out.push(entry(x, "changed"));
  }
  for (const x of before) if (!next.has(x.id)) out.push(entry(x, "removed"));
  return out;
}

/**
 * 列出改动。
 *
 * @param base 改动前。
 * @param next 改动后。
 * @param lang 界面语言（特效名）。
 * @returns 改动，片段按时间排序在前，其它对象在后。
 */
export function listChanges(base: ShowProject, next: ShowProject, lang: string): ChangeEntry[] {
  const span = (c: Cue) => `${formatTimecode(c.startMs)} – ${formatTimecode(c.endMs)}`;
  const cues = diffBy(base.cues, next.cues, "cues", (c) => cueLabel(c, lang), span, (c) => c.startMs).sort(
    (a, b) => (a.atMs ?? 0) - (b.atMs ?? 0),
  );
  const out: ChangeEntry[] = [
    ...cues,
    ...diffBy(base.groups, next.groups, "groups", (g) => g.name, (g) => String(g.fixtureIds.length)),
    ...diffBy(base.fixtures, next.fixtures, "fixtures", (f) => f.name, (f) => `U${f.universe}.${f.address}`),
    ...diffBy(base.sections, next.sections, "sections", (s) => s.name, (s) => `${formatTimecode(s.startMs)} – ${formatTimecode(s.endMs)}`),
    ...diffBy(base.markers, next.markers, "markers", (m) => m.label, (m) => formatTimecode(m.timeMs)),
  ];
  if (base.tempo !== next.tempo) {
    out.push({ collection: "tempo", op: "changed", label: "BPM", detail: `${base.tempo?.bpm ?? "—"} → ${next.tempo?.bpm ?? "—"}` });
  }
  if (base.output.target !== next.output.target) {
    out.push({ collection: "output", op: "changed", label: "output", detail: `${targetText(base.output.target)} → ${targetText(next.output.target)}` });
  }
  if (base.durationMs !== next.durationMs) {
    out.push({ collection: "duration", op: "changed", label: "duration", detail: `${formatTimecode(base.durationMs)} → ${formatTimecode(next.durationMs)}` });
  }
  return out;
}

/**
 * 按种类与操作计数（审阅卡片的标题行）。
 *
 * @param changes 改动。
 * @returns `[种类, 操作, 数量]`，按出现顺序。
 */
export function countChanges(changes: readonly ChangeEntry[]): [ChangeCollection, ChangeEntry["op"], number][] {
  const counts = new Map<string, number>();
  for (const c of changes) counts.set(`${c.collection}:${c.op}`, (counts.get(`${c.collection}:${c.op}`) ?? 0) + 1);
  return [...counts].map(([k, n]) => {
    const [collection, op] = k.split(":") as [ChangeCollection, ChangeEntry["op"]];
    return [collection, op, n];
  });
}

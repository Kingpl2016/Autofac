import { footprint } from "@/features/fixtures";
import { templateName } from "../lib/cueTemplates";
import { effectName } from "../lib/effectLibrary";
import type { Cue, FixtureInstance, OutputTarget, ShowProject, StagePlacement } from "../lib/project";
import { formatTimecode } from "../lib/time";
import { DEFAULT_HAZE } from "../lib/stageOps";
import { placeFixtures } from "../stage/stageGeometry";
import type { LibraryChanges } from "./compile";

/**
 * AI 改动的清单：比较改动前后的工程，逐项列出新增 / 删除 / 修改了什么（审阅卡片用）。
 *
 * 与撤销历史的 `describeChange` 同样依赖 immer 的结构共享（没改的对象引用不变），
 * 但这里列出每一项，而不只是“最有代表性的一类”。
 */

/** 清单里出现的对象种类。 */
export type ChangeCollection =
  | "cues"
  | "groups"
  | "fixtures"
  | "placements"
  | "stageObjects"
  | "stage"
  | "sections"
  | "markers"
  | "tempo"
  | "output"
  | "duration"
  | "libEffects"
  | "libTemplates"
  | "libModels";

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
 * @param library 应用时写进用户库的内容。
 * @returns 改动，片段按时间排序在前，其它对象在后。
 */
export function listChanges(base: ShowProject, next: ShowProject, lang: string, library?: LibraryChanges): ChangeEntry[] {
  const span = (c: Cue) => `${formatTimecode(c.startMs)} – ${formatTimecode(c.endMs)}`;
  const cues = diffBy(base.cues, next.cues, "cues", (c) => cueLabel(c, lang), span, (c) => c.startMs).sort(
    (a, b) => (a.atMs ?? 0) - (b.atMs ?? 0),
  );
  // 只改了舞台位置的灯具单独列为“摆位”，不和配接改动混在一起
  const fixtureChanges = diffBy(base.fixtures, next.fixtures, "fixtures", (f) => f.name, (f) => `U${f.universe}.${f.address}`);
  const before = new Map(base.fixtures.map((f) => [f.id, f]));
  const after = new Map(next.fixtures.map((f) => [f.id, f]));
  // 第一次摆位时其它灯会被固定在原来的自动排布位置上：看起来没动的不列出
  const auto = fixtureChanges.length > 0 ? placeFixtures(base.fixtures, base.stage) : new Map<string, StagePlacement>();
  const fixtures = fixtureChanges.flatMap((c): ChangeEntry[] => {
    const old = c.id ? before.get(c.id) : undefined;
    const now = c.id ? after.get(c.id) : undefined;
    if (c.op !== "changed" || !old || !now || !onlyPlacementChanged(old, now)) return [c];
    const s = now.stage;
    const was = old.stage ?? auto.get(old.id);
    if (s && was && samePlacement(was, s)) return [];
    return [{ ...c, collection: "placements", ...(s ? { detail: `${round1(s.x)}, ${round1(s.y)} m` } : {}) }];
  });
  const out: ChangeEntry[] = [
    ...cues,
    ...diffBy(base.groups, next.groups, "groups", (g) => g.name, (g) => String(g.fixtureIds.length)),
    ...fixtures,
    ...diffBy(base.stage.objects, next.stage.objects, "stageObjects", (o) => o.label || o.kind, (o) => `${round1(o.x)}, ${round1(o.y)} m`),
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
  if (base.stage.width !== next.stage.width || base.stage.depth !== next.stage.depth || (base.stage.height ?? 0) !== (next.stage.height ?? 0)) {
    const size = (s: ShowProject["stage"]) => `${s.width}×${s.depth}${s.height ? `×${s.height}` : ""}`;
    out.push({ collection: "stage", op: "changed", label: "stage", detail: `${size(base.stage)} → ${size(next.stage)} m` });
  }
  if ((base.stage.haze ?? DEFAULT_HAZE) !== (next.stage.haze ?? DEFAULT_HAZE)) {
    const pct = (s: ShowProject["stage"]) => `${Math.round((s.haze ?? DEFAULT_HAZE) * 100)}%`;
    out.push({ collection: "stage", op: "changed", label: "haze", detail: `${pct(base.stage)} → ${pct(next.stage)}` });
  }
  for (const e of library?.effects ?? []) out.push({ collection: "libEffects", op: "added", id: e.id, label: effectName(e, lang), detail: e.id });
  for (const tpl of library?.templates ?? []) out.push({ collection: "libTemplates", op: "added", id: tpl.id, label: templateName(tpl, lang), detail: tpl.id });
  for (const m of library?.models ?? []) out.push({ collection: "libModels", op: "added", id: m.id, label: m.name, detail: `${footprint(m.properties)} ch` });
  return out;
}

/** 保留一位小数。 */
const round1 = (v: number) => Math.round(v * 10) / 10;

/** 两个摆位看起来一样（坐标差不到 1 cm，高度、朝向、吊挂相同）。 */
function samePlacement(a: StagePlacement, b: StagePlacement): boolean {
  return (
    Math.abs(a.x - b.x) < 0.01 &&
    Math.abs(a.y - b.y) < 0.01 &&
    (a.z ?? 0) === (b.z ?? 0) &&
    (a.rotation ?? 0) === (b.rotation ?? 0) &&
    (a.pitch ?? 0) === (b.pitch ?? 0) &&
    !!a.hanging === !!b.hanging
  );
}

/** 两个灯具是否只有舞台位置不同。 */
function onlyPlacementChanged(a: FixtureInstance, b: FixtureInstance): boolean {
  const { stage: _a, ...restA } = a;
  const { stage: _b, ...restB } = b;
  void _a;
  void _b;
  return JSON.stringify(restA) === JSON.stringify(restB);
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

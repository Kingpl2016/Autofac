import type { ShowProject } from "../lib/project";

/**
 * AI 改动的还原点（纯函数）：每次写入 AI 的改动（对话提议、草稿、主动建议）记下改了什么——
 * 按工程的顶层字段，带 id 的列表（片段、轨道、分组、段落…）逐项记下新增 / 删除 / 修改前后，其它字段记下前后的值。
 *
 * - “只撤回这次改动”：三方比较——当前的样子还和 AI 改完时一样的才改回去；之后又手动改过的跳过（报告冲突数），
 *   不影响 AI 没碰过的内容；
 * - “恢复到这次之前”：这一次以及之后的 AI 改动全部强制改回（冲突的也覆盖）；
 * - “重新应用”：反方向的三方比较。
 *
 * 每个还原点只存改动的部分；同一个工程最多 20 个，跟着工程的 AI 记录保存在数据目录。
 */

/** 每个工程最多保留多少个还原点。 */
export const MAX_RESTORE_POINTS = 20;
/** 单个还原点的大小上限（JSON 字符数）；超过的不保存细节。 */
export const MAX_POINT_CHARS = 1_500_000;
/** 全部还原点的大小上限（JSON 字符数），超过时丢掉最早的。 */
export const MAX_TOTAL_CHARS = 6_000_000;

/** 带 id 的一项。 */
type Item = { id: string } & Record<string, unknown>;

/** 一个顶层字段的改动。 */
export type FieldChange =
  | { key: string; kind: "items"; added: Item[]; removed: { item: Item; index: number }[]; changed: { before: Item; after: Item }[] }
  | { key: string; kind: "value"; before: unknown; after: unknown };

/** 一个还原点。 */
export interface RestorePoint {
  id: string;
  /** 写入时间（Unix 毫秒） */
  at: number;
  /** 说明（AI 的一句话总结） */
  summary: string;
  source: "chat" | "draft" | "suggestion";
  /** 对话里产生这次改动的工具调用 id（对话回退、提议卡片上的撤回用） */
  sourceId?: string;
  /** 改动 */
  changes: FieldChange[];
  /** 当前状态：已应用 / 已撤回 */
  state: "applied" | "reverted";
  /** 改动的片段数（列表里显示） */
  cueCount: number;
}

/** 还原的结果。 */
export interface RestoreResult {
  next: ShowProject;
  /** 改了几处 */
  applied: number;
  /** 因为之后又改过而跳过的几处 */
  skipped: number;
}

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
const isItems = (v: unknown): v is Item[] => Array.isArray(v) && v.every((x) => typeof x === "object" && x !== null && typeof (x as { id?: unknown }).id === "string");

/**
 * 由写入前后的工程得到改动。
 *
 * @param before 写入前。
 * @param after 写入后。
 * @returns 改动（没有变化的字段不记）。
 */
export function diffProjects(before: ShowProject, after: ShowProject): FieldChange[] {
  const out: FieldChange[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const a = (before as unknown as Record<string, unknown>)[key];
    const b = (after as unknown as Record<string, unknown>)[key];
    if (a === b) continue;
    if (isItems(a) && isItems(b)) {
      const byA = new Map(a.map((x) => [x.id, x]));
      const byB = new Map(b.map((x) => [x.id, x]));
      const added = b.filter((x) => !byA.has(x.id));
      const removed = a.flatMap((x, index) => (byB.has(x.id) ? [] : [{ item: x, index }]));
      const changed = b.flatMap((x) => {
        const prev = byA.get(x.id);
        return prev && prev !== x && !same(prev, x) ? [{ before: prev, after: x }] : [];
      });
      if (added.length + removed.length + changed.length > 0) out.push({ key, kind: "items", added, removed, changed });
      continue;
    }
    if (!same(a, b)) out.push({ key, kind: "value", before: a, after: b });
  }
  return out;
}

/**
 * 生成还原点。
 *
 * @param before 写入前。
 * @param after 写入后。
 * @param meta 说明与来源。
 * @returns 还原点；没有变化或太大时为 `null`。
 */
export function makeRestorePoint(
  before: ShowProject,
  after: ShowProject,
  meta: { summary: string; source: RestorePoint["source"]; sourceId?: string; at?: number },
): RestorePoint | null {
  const changes = diffProjects(before, after);
  if (changes.length === 0) return null;
  const cues = changes.find((c) => c.key === "cues");
  const point: RestorePoint = {
    id: `rp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    at: meta.at ?? Date.now(),
    summary: meta.summary.slice(0, 200),
    source: meta.source,
    ...(meta.sourceId ? { sourceId: meta.sourceId } : {}),
    changes,
    state: "applied",
    cueCount: cues?.kind === "items" ? cues.added.length + cues.removed.length + cues.changed.length : 0,
  };
  return JSON.stringify(point).length > MAX_POINT_CHARS ? null : point;
}

/** 反方向的改动（重新应用用）。 */
function invert(c: FieldChange): FieldChange {
  if (c.kind === "value") return { ...c, before: c.after, after: c.before };
  return {
    key: c.key,
    kind: "items",
    added: c.removed.map((r) => r.item),
    removed: c.added.map((item, index) => ({ item, index })),
    changed: c.changed.map((x) => ({ before: x.after, after: x.before })),
  };
}

/**
 * 把一组改动“改回 before”：三方比较，当前与 after 一致才改；`force` 时一律改。
 *
 * @param project 当前工程。
 * @param changes 改动。
 * @param force 冲突时也覆盖。
 * @returns 结果。
 */
function revertChanges(project: ShowProject, changes: readonly FieldChange[], force: boolean): RestoreResult {
  const next = { ...project } as unknown as Record<string, unknown>;
  let applied = 0;
  let skipped = 0;
  for (const c of changes) {
    const cur = next[c.key];
    if (c.kind === "value") {
      if (same(cur, c.before)) continue;
      if (force || same(cur, c.after)) {
        next[c.key] = c.before;
        applied += 1;
      } else skipped += 1;
      continue;
    }
    const list: Item[] = isItems(cur) ? [...cur] : [];
    const indexOf = (id: string) => list.findIndex((x) => x.id === id);
    for (const item of c.added) {
      const at = indexOf(item.id);
      if (at < 0) continue;
      if (force || same(list[at], item)) {
        list.splice(at, 1);
        applied += 1;
      } else skipped += 1;
    }
    for (const x of c.changed) {
      const at = indexOf(x.after.id);
      if (at < 0) {
        if (force) {
          list.push(x.before);
          applied += 1;
        } else skipped += 1;
      } else if (same(list[at], x.before)) {
        // 已经是改之前的样子
      } else if (force || same(list[at], x.after)) {
        list[at] = x.before;
        applied += 1;
      } else skipped += 1;
    }
    for (const r of c.removed) {
      const at = indexOf(r.item.id);
      if (at >= 0) {
        if (same(list[at], r.item)) continue;
        if (force) {
          list[at] = r.item;
          applied += 1;
        } else skipped += 1;
        continue;
      }
      list.splice(Math.min(r.index, list.length), 0, r.item);
      applied += 1;
    }
    next[c.key] = list;
  }
  return { next: next as unknown as ShowProject, applied, skipped };
}

/**
 * 只撤回这一次改动（之后又改过的跳过）。
 *
 * @param project 当前工程。
 * @param point 还原点。
 * @returns 结果。
 */
export function revertPoint(project: ShowProject, point: RestorePoint): RestoreResult {
  return revertChanges(project, point.changes, false);
}

/**
 * 恢复到某次改动之前：这一次及之后（列表里更新的）已应用的改动，从新到旧强制改回。
 *
 * @param project 当前工程。
 * @param points 还原点（从旧到新）。
 * @param id 目标还原点。
 * @returns 结果与被改回的还原点 id。
 */
export function restoreBefore(project: ShowProject, points: readonly RestorePoint[], id: string): RestoreResult & { reverted: string[] } {
  const from = points.findIndex((p) => p.id === id);
  if (from < 0) return { next: project, applied: 0, skipped: 0, reverted: [] };
  let cur = project;
  let applied = 0;
  const reverted: string[] = [];
  for (const p of [...points.slice(from)].reverse()) {
    if (p.state !== "applied") continue;
    const r = revertChanges(cur, p.changes, true);
    cur = r.next;
    applied += r.applied;
    reverted.push(p.id);
  }
  return { next: cur, applied, skipped: 0, reverted };
}

/**
 * 重新应用撤回过的改动（之后又改过的跳过）。
 *
 * @param project 当前工程。
 * @param point 还原点。
 * @returns 结果。
 */
export function reapplyPoint(project: ShowProject, point: RestorePoint): RestoreResult {
  return revertChanges(project, point.changes.map(invert), false);
}

/**
 * 加入一个还原点：最多 20 个、总大小不超过上限（丢最早的）。
 *
 * @param points 现有还原点（从旧到新）。
 * @param point 新还原点。
 * @returns 新列表。
 */
export function pushPoint(points: readonly RestorePoint[], point: RestorePoint): RestorePoint[] {
  let out = [...points, point].slice(-MAX_RESTORE_POINTS);
  while (out.length > 1 && JSON.stringify(out).length > MAX_TOTAL_CHARS) out = out.slice(1);
  return out;
}

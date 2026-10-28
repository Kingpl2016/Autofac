import { trackFixtureIds } from "./ops";
import type { ShowProject } from "./project";

/**
 * 灯具选择工具（参考 grandMA 的 MAtricks / QLC+ 的选择方式）：全选、反选、奇偶、隔 N 选 1、
 * 前后半、按分组 / 模型 / 轨道选择、逐个前进后退。
 *
 * 全部是纯函数：输入工程里的灯具顺序（Patch 列表顺序）与当前选择，返回新的选择（保持工程顺序，
 * 只有“按分组”保持分组成员顺序）。
 */

/** 隔 N 选 1 等“图案”选择。 */
export type SelectionPattern =
  | { kind: "odd" }
  | { kind: "even" }
  | { kind: "firstHalf" }
  | { kind: "secondHalf" }
  /** 每 `n` 个取第 `offset` 个（0 起） */
  | { kind: "every"; n: number; offset: number };

/**
 * 按工程顺序排列选择（去掉不存在的、重复的）。
 *
 * @param all 工程里全部灯具 id（顺序）。
 * @param selected 选择。
 * @returns 排好序的选择。
 */
export function ordered(all: readonly string[], selected: readonly string[]): string[] {
  const set = new Set(selected);
  return all.filter((id) => set.has(id));
}

/**
 * 反选。
 *
 * @param all 全部灯具 id。
 * @param selected 当前选择。
 * @returns 未被选中的灯具。
 */
export function invertSelection(all: readonly string[], selected: readonly string[]): string[] {
  const set = new Set(selected);
  return all.filter((id) => !set.has(id));
}

/**
 * 在“基础集合”上按图案取子集：有选择时作用于选择，没有选择时作用于全部灯具。
 *
 * @param all 全部灯具 id。
 * @param selected 当前选择。
 * @param pattern 图案。
 * @returns 新选择。
 */
export function applyPattern(all: readonly string[], selected: readonly string[], pattern: SelectionPattern): string[] {
  const base = selected.length > 0 ? ordered(all, selected) : [...all];
  const n = base.length;
  switch (pattern.kind) {
    case "odd":
      return base.filter((_, i) => i % 2 === 0);
    case "even":
      return base.filter((_, i) => i % 2 === 1);
    case "firstHalf":
      return base.slice(0, Math.ceil(n / 2));
    case "secondHalf":
      return base.slice(Math.ceil(n / 2));
    case "every": {
      const step = Math.max(1, Math.floor(pattern.n));
      const offset = ((Math.floor(pattern.offset) % step) + step) % step;
      return base.filter((_, i) => i % step === offset);
    }
  }
}

/**
 * 逐个前进 / 后退（grandMA 的 Next / Previous）：选择变成当前选择最后一个（或第一个）的下一（上一）台，循环。
 *
 * @param all 全部灯具 id。
 * @param selected 当前选择。
 * @param direction `1` 下一个，`-1` 上一个。
 * @returns 只含一台灯具的选择；没有灯具时为空。
 */
export function stepSelection(all: readonly string[], selected: readonly string[], direction: 1 | -1): string[] {
  if (all.length === 0) return [];
  const sorted = ordered(all, selected);
  if (sorted.length === 0) return [direction === 1 ? all[0] : all[all.length - 1]];
  const anchor = direction === 1 ? sorted[sorted.length - 1] : sorted[0];
  const i = all.indexOf(anchor);
  return [all[(i + direction + all.length) % all.length]];
}

/**
 * 选中某个分组的成员（保持成员顺序，分布 / 特效按它推进）。
 *
 * @param project 工程（只读）。
 * @param groupId 分组 id。
 * @returns 成员 id；分组不存在时为空。
 */
export function groupSelection(project: Pick<ShowProject, "groups" | "fixtures">, groupId: string): string[] {
  const known = new Set(project.fixtures.map((f) => f.id));
  return (project.groups.find((g) => g.id === groupId)?.fixtureIds ?? []).filter((id) => known.has(id));
}

/**
 * 选中同一模型（同一类灯）的全部灯具。
 *
 * @param project 工程（只读）。
 * @param modelId 模型编号。
 * @returns 灯具 id。
 */
export function modelSelection(project: Pick<ShowProject, "fixtures">, modelId: string): string[] {
  return project.fixtures.filter((f) => f.modelId === modelId).map((f) => f.id);
}

/**
 * 选中一条轨道驱动的灯具（灯具轨道为一台，分组轨道为成员，场景轨道为其片段涉及的灯具）。
 *
 * @param project 工程（只读）。
 * @param trackId 轨道 id。
 * @returns 灯具 id。
 */
export function trackSelection(project: Pick<ShowProject, "tracks" | "fixtures" | "groups" | "cues">, trackId: string): string[] {
  const track = project.tracks.find((t) => t.id === trackId);
  return track ? trackFixtureIds(project, track) : [];
}

/** 一组轨道对应的灯具选择。 */
export interface TrackFixtureSelection {
  /** 这些轨道驱动的灯具（按轨道顺序、去重） */
  fixtureIds: string[];
  /** 只选了一条分组轨道时为该分组，否则为 `null` */
  groupId: string | null;
}

/**
 * 把轨道选择换算成灯具选择（时间线点轨道 / 片段时与 Patch、编程器、舞台联动）。
 *
 * 灯具轨道为一台，分组轨道为全部成员（成员顺序），场景轨道为其片段涉及的灯具；已删除的轨道忽略。
 *
 * @param project 工程（只读）。
 * @param trackIds 轨道 id（按选择顺序）。
 * @returns 灯具与分组。
 */
export function selectionOfTracks(
  project: Pick<ShowProject, "tracks" | "fixtures" | "groups" | "cues">,
  trackIds: readonly string[],
): TrackFixtureSelection {
  const seen = new Set<string>();
  const fixtureIds: string[] = [];
  for (const id of trackIds) {
    for (const f of trackSelection(project, id)) {
      if (seen.has(f)) continue;
      seen.add(f);
      fixtureIds.push(f);
    }
  }
  const tracks = trackIds.map((id) => project.tracks.find((t) => t.id === id)).filter((t) => t !== undefined);
  const only = tracks.length === 1 ? tracks[0].target : null;
  const groupId = only?.kind === "group" && project.groups.some((g) => g.id === only.id) ? only.id : null;
  return { fixtureIds, groupId };
}

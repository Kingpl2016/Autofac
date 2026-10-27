import type { FixtureModel } from "@/features/fixtures";
import { channelCount } from "@/features/fixtures";
import { DMX_CHANNELS, MAX_UNIVERSE, type FixtureInstance, type ShowProject } from "./project";

/** 灯具在某个 Universe 里占用的通道区间（闭区间，地址从 1 起）。 */
export interface PatchRange {
  universe: number;
  start: number;
  end: number;
}

/** 一个灯具的 Patch 状态。 */
export interface PatchStatus {
  /** 该灯具占用的区间；找不到模型时为 `null` */
  range: PatchRange | null;
  /** 与之重叠的其他灯具 id */
  conflictsWith: string[];
  /** 末尾通道超出 512 */
  overflow: boolean;
  /** 工程里缺少该灯具的模型快照 */
  missingModel: boolean;
}

/**
 * 灯具占用的通道数；模型缺失时按 1 个通道处理，避免界面崩溃。
 *
 * @param model 灯具模型。
 * @returns 至少为 1 的通道数。
 */
export function footprintOf(model: FixtureModel | undefined): number {
  return Math.max(1, model ? channelCount(model) : 1);
}

/**
 * 分析整个工程的 Patch：每个灯具占用哪些通道、与谁冲突、是否越界。
 *
 * @param project 工程（只读）。
 * @returns 灯具 id 到 Patch 状态的映射，顺序与 `project.fixtures` 一致。
 */
export function analyzePatch(
  project: Pick<ShowProject, "fixtures" | "fixtureModels">,
): Map<string, PatchStatus> {
  const models = new Map(project.fixtureModels.map((m) => [m.id, m]));
  const result = new Map<string, PatchStatus>();
  const byUniverse = new Map<number, { fixture: FixtureInstance; range: PatchRange }[]>();

  for (const fixture of project.fixtures) {
    const model = models.get(fixture.modelId);
    const range: PatchRange = {
      universe: fixture.universe,
      start: fixture.address,
      end: fixture.address + footprintOf(model) - 1,
    };
    result.set(fixture.id, {
      range: model ? range : null,
      conflictsWith: [],
      overflow: range.end > DMX_CHANNELS,
      missingModel: !model,
    });
    const list = byUniverse.get(fixture.universe) ?? [];
    list.push({ fixture, range });
    byUniverse.set(fixture.universe, list);
  }

  for (const list of byUniverse.values()) {
    list.sort((a, b) => a.range.start - b.range.start);
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length && list[j].range.start <= list[i].range.end; j += 1) {
        result.get(list[i].fixture.id)?.conflictsWith.push(list[j].fixture.id);
        result.get(list[j].fixture.id)?.conflictsWith.push(list[i].fixture.id);
      }
    }
  }
  return result;
}

/**
 * 找到第一个放得下 `footprint` 个通道的空位（首次适配）。
 *
 * 从 `fromUniverse` 开始逐个 Universe 查找：先看已占用区间之间的空隙，再看末尾。
 *
 * @param project 工程（只读）。
 * @param footprint 需要的通道数。
 * @param fromUniverse 起始搜索的 Universe，默认 0。
 * @returns 空位的 Universe 与起始地址；整个 Universe 范围内都放不下时为 `null`。
 */
export function nextFreeSlot(
  project: Pick<ShowProject, "fixtures" | "fixtureModels">,
  footprint: number,
  fromUniverse = 0,
): { universe: number; address: number } | null {
  if (footprint < 1 || footprint > DMX_CHANNELS) return null;
  const models = new Map(project.fixtureModels.map((m) => [m.id, m]));
  const occupied = new Map<number, [number, number][]>();
  for (const f of project.fixtures) {
    const end = f.address + footprintOf(models.get(f.modelId)) - 1;
    const list = occupied.get(f.universe) ?? [];
    list.push([f.address, end]);
    occupied.set(f.universe, list);
  }
  for (let universe = Math.max(0, fromUniverse); universe <= MAX_UNIVERSE; universe += 1) {
    const ranges = (occupied.get(universe) ?? []).sort((a, b) => a[0] - b[0]);
    let cursor = 1;
    for (const [start, end] of ranges) {
      if (start - cursor >= footprint) return { universe, address: cursor };
      cursor = Math.max(cursor, end + 1);
    }
    if (cursor + footprint - 1 <= DMX_CHANNELS) return { universe, address: cursor };
  }
  return null;
}

/**
 * 工程用到的全部 Universe（升序、去重）。
 *
 * @param fixtures 灯具实例。
 * @returns 有灯具的 Universe 编号。
 */
export function usedUniverses(fixtures: readonly FixtureInstance[]): number[] {
  return [...new Set(fixtures.map((f) => f.universe))].sort((a, b) => a - b);
}

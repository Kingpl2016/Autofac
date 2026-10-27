import type { FixtureModel } from "@/features/fixtures";
import { footprint, layoutOf } from "@/features/fixtures";
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
  /** 多重配接（镜像地址）占用的区间，顺序同 `fixture.mirrors`；找不到模型时为空 */
  mirrors: PatchRange[];
  /** 与之重叠的其他灯具 id */
  conflictsWith: string[];
  /** 末尾通道超出 512 */
  overflow: boolean;
  /** 工程里缺少该灯具的模型快照 */
  missingModel: boolean;
}

/**
 * 灯具占用的通道数；模型或模式缺失时按 1 个通道处理，避免界面崩溃。
 *
 * @param model 灯具模型。
 * @param modeId 灯具选用的通道模式；省略为默认模式。
 * @returns 至少为 1 的通道数。
 */
export function footprintOf(model: FixtureModel | undefined, modeId?: string): number {
  const layout = model ? layoutOf(model, modeId) : null;
  return Math.max(1, layout ? footprint(layout) : 1);
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
    const width = footprintOf(model, fixture.modeId);
    const rangeAt = (universe: number, address: number): PatchRange => ({
      universe,
      start: address,
      end: address + width - 1,
    });
    const range = rangeAt(fixture.universe, fixture.address);
    const mirrors = (fixture.mirrors ?? []).map((m) => rangeAt(m.universe, m.address));
    result.set(fixture.id, {
      range: model ? range : null,
      mirrors: model ? mirrors : [],
      conflictsWith: [],
      overflow: [range, ...mirrors].some((r) => r.end > DMX_CHANNELS),
      missingModel: !model,
    });
    for (const r of [range, ...mirrors]) {
      const list = byUniverse.get(r.universe) ?? [];
      list.push({ fixture, range: r });
      byUniverse.set(r.universe, list);
    }
  }

  const link = (a: string, b: string) => {
    const list = result.get(a)?.conflictsWith;
    if (list && !list.includes(b)) list.push(b);
  };
  for (const list of byUniverse.values()) {
    list.sort((a, b) => a.range.start - b.range.start);
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length && list[j].range.start <= list[i].range.end; j += 1) {
        const a = list[i].fixture.id;
        const b = list[j].fixture.id;
        // 灯具自己的镜像与主地址重叠也算冲突（同一通道被写两次）
        link(a, b);
        if (a !== b) link(b, a);
      }
    }
  }
  return result;
}

/** 某个 Universe 上的一段占用。 */
export interface UniverseSpan {
  fixtureId: string;
  range: PatchRange;
  /** 是否为多重配接的镜像地址 */
  mirror: boolean;
}

/**
 * 灯具占用的全部区间（主地址 + 镜像），按 Universe 分组。
 *
 * @param project 工程（只读）。
 * @returns Universe → 占用列表（按起始地址升序）。
 */
export function spansByUniverse(project: Pick<ShowProject, "fixtures" | "fixtureModels">): Map<number, UniverseSpan[]> {
  const models = new Map(project.fixtureModels.map((m) => [m.id, m]));
  const out = new Map<number, UniverseSpan[]>();
  for (const f of project.fixtures) {
    const width = footprintOf(models.get(f.modelId), f.modeId);
    const all = [
      { universe: f.universe, address: f.address, mirror: false },
      ...(f.mirrors ?? []).map((m) => ({ ...m, mirror: true })),
    ];
    for (const a of all) {
      const list = out.get(a.universe) ?? [];
      list.push({
        fixtureId: f.id,
        range: { universe: a.universe, start: a.address, end: a.address + width - 1 },
        mirror: a.mirror,
      });
      out.set(a.universe, list);
    }
  }
  for (const list of out.values()) list.sort((a, b) => a.range.start - b.range.start);
  return out;
}

/**
 * 每个 Universe 实际占用的通道数（重叠只算一次，超过 512 的部分不算）。
 *
 * @param project 工程（只读）。
 * @returns Universe → 已用通道数。
 */
export function universeUsage(project: Pick<ShowProject, "fixtures" | "fixtureModels">): Map<number, number> {
  const out = new Map<number, number>();
  for (const [universe, spans] of spansByUniverse(project)) {
    let used = 0;
    let cursor = 0;
    for (const { range } of spans) {
      const start = Math.max(range.start, cursor + 1);
      const end = Math.min(range.end, DMX_CHANNELS);
      if (end >= start) used += end - start + 1;
      cursor = Math.max(cursor, end);
    }
    out.set(universe, used);
  }
  return out;
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
  const occupied = spansByUniverse(project);
  for (let universe = Math.max(0, fromUniverse); universe <= MAX_UNIVERSE; universe += 1) {
    const ranges = (occupied.get(universe) ?? []).map((s) => [s.range.start, s.range.end] as const);
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
 * 工程用到的全部 Universe（升序、去重，含多重配接的镜像地址）。
 *
 * @param fixtures 灯具实例。
 * @returns 有灯具的 Universe 编号。
 */
export function usedUniverses(fixtures: readonly FixtureInstance[]): number[] {
  const all = fixtures.flatMap((f) => [f.universe, ...(f.mirrors ?? []).map((m) => m.universe)]);
  return [...new Set(all)].sort((a, b) => a - b);
}

/**
 * 顺序配接（批量重新配接）：从起点开始依次排布灯具，当前 Universe 放不下时自动换到下一个 Universe 的 1 号地址。
 *
 * 只计算新地址，不检查与其它灯具的冲突（结果由 `analyzePatch` 标出）。
 *
 * @param widths 每个灯具占用的通道数（按排布顺序）。
 * @param start 第一个灯具的地址。
 * @param gap 相邻灯具之间空出的通道数（≥ 0）。
 * @returns 每个灯具的新地址；某个灯具单独就超过 512 通道或 Universe 用尽时，它及之后的为 `null`。
 */
export function sequentialAddresses(
  widths: readonly number[],
  start: { universe: number; address: number },
  gap = 0,
): ({ universe: number; address: number } | null)[] {
  let universe = Math.max(0, Math.floor(start.universe));
  let address = Math.min(Math.max(1, Math.floor(start.address)), DMX_CHANNELS);
  const spacing = Math.max(0, Math.floor(gap));
  const out: ({ universe: number; address: number } | null)[] = [];
  let failed = false;
  for (const width of widths) {
    if (failed || width > DMX_CHANNELS) {
      failed = true;
      out.push(null);
      continue;
    }
    if (address + width - 1 > DMX_CHANNELS) {
      universe += 1;
      address = 1;
    }
    if (universe > MAX_UNIVERSE) {
      failed = true;
      out.push(null);
      continue;
    }
    out.push({ universe, address });
    address += width + spacing;
  }
  return out;
}

/** 一个 DMX 通道归属的灯具与属性。 */
export interface ChannelOwner {
  fixtureId: string;
  fixtureName: string;
  /** 属性名（布局里没有覆盖到的通道为空串） */
  property: string;
  /** 16 位属性的低字节（Fine） */
  fine: boolean;
  /** 是否为多重配接的镜像地址 */
  mirror: boolean;
}

/**
 * 查找某个通道属于哪些灯具的哪个属性（DMX 通道视图的悬停 / 点击说明）。
 *
 * @param project 工程（只读）。
 * @param universe 工程内 Universe。
 * @param channel 通道 1~512。
 * @returns 归属列表（地址冲突时可能有多个）；空通道为空数组。
 */
export function channelOwners(
  project: Pick<ShowProject, "fixtures" | "fixtureModels">,
  universe: number,
  channel: number,
): ChannelOwner[] {
  const models = new Map(project.fixtureModels.map((m) => [m.id, m]));
  const fixtures = new Map(project.fixtures.map((f) => [f.id, f]));
  const out: ChannelOwner[] = [];
  for (const span of spansByUniverse(project).get(universe) ?? []) {
    if (channel < span.range.start || channel > span.range.end) continue;
    const fixture = fixtures.get(span.fixtureId);
    if (!fixture) continue;
    const model = models.get(fixture.modelId);
    const layout = model ? layoutOf(model, fixture.modeId) : null;
    const offset = channel - span.range.start + 1;
    const prop = layout?.find((p) => offset >= p.channel && offset <= p.channel + p.width - 1);
    out.push({
      fixtureId: fixture.id,
      fixtureName: fixture.name,
      property: prop?.name ?? "",
      fine: prop ? prop.width === 2 && offset === (prop.bigEndian ? prop.channel + 1 : prop.channel) : false,
      mirror: span.mirror,
    });
  }
  return out;
}

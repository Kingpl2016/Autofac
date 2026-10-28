import type { FixtureModel } from "@/features/fixtures";
import { newId } from "./ids";
import { footprintOf, spansByUniverse } from "./patch";
import { DMX_CHANNELS, MAX_UNIVERSE, type FixtureInstance, type PatchAddress, type ShowProject } from "./project";
import { clampToStage, materializePlacements } from "./stageOps";

/**
 * 批量添加灯具的“计划 → 执行”两步：
 * - `planAddFixtures` 是纯函数，界面用它实时预览将占用的地址、名称和放不下的数量；
 * - `applyAddPlan` 把计划写进草稿（调用方放在一次 `update` 里，即一步撤销）。
 */

/** 一次最多添加的灯具数量。 */
export const MAX_ADD_COUNT = 128;

/** 相邻灯具之间最多空出的通道数。 */
export const MAX_ADD_GAP = 64;

/** 拖到舞台上时一排灯具的间距（米）。 */
export const STAGE_ROW_SPACING_M = 0.5;

/** 名称模板里的序号占位符。 */
export const NAME_PLACEHOLDER = "{n}";

/** 批量添加的选项。 */
export interface AddFixturesOptions {
  /** 数量，夹在 `1..=`[`MAX_ADD_COUNT`] */
  count: number;
  /** 通道模式；省略为默认模式 */
  modeId?: string;
  /** 起始地址：`auto` 从最后一台灯所在的 Universe 起找第一个空位；给定地址被占用时顺延到其后的第一个空位 */
  start?: "auto" | PatchAddress;
  /** 相邻灯具之间空出的通道数 */
  gap?: number;
  /** 名称模板，`{n}` 为序号（接着该模型已有的台数编号）；省略为“模型名 {n}” */
  nameTemplate?: string;
  /** 舞台落点（米）：新灯排成一排、以落点为中心，夹在舞台范围内；省略时按序自动排布 */
  stagePoint?: { x: number; y: number };
}

/** 计划里的一台灯。 */
export interface AddPlanItem {
  name: string;
  universe: number;
  address: number;
  /** 舞台位置（只有给了落点时才有） */
  stage?: { x: number; y: number };
}

/** 一个 Universe 上将被占用的连续区间（闭区间）。 */
export interface AddPlanRange {
  universe: number;
  start: number;
  end: number;
}

/** 批量添加的计划。 */
export interface AddPlan {
  modelId: string;
  modeId?: string;
  /** 每台灯占用的通道数 */
  footprint: number;
  /** 请求的数量（夹取后） */
  requested: number;
  /** 放得下的灯（可能少于 `requested`） */
  items: AddPlanItem[];
  /** 将占用的区间（同一 Universe 内相邻的合并） */
  ranges: AddPlanRange[];
  /** 给定的起始地址被占用、顺延到了别处 */
  shifted: boolean;
}

/**
 * 按名称模板生成名称。
 *
 * @param template 模板；不含 `{n}` 且要添加多台时在末尾补“ {n}”，避免重名。
 * @param n 序号。
 * @param many 是否添加多台。
 * @returns 名称。
 */
export function formatFixtureName(template: string, n: number, many: boolean): string {
  const t = template.trim();
  const withN = t.includes(NAME_PLACEHOLDER) || !many ? t : `${t} ${NAME_PLACEHOLDER}`;
  return withN.split(NAME_PLACEHOLDER).join(String(n));
}

/**
 * 从 `cursor` 起找第一个放得下 `width` 个通道的空位（同一 Universe 内向后找，放不下换到下一个 Universe 的 1 号地址）。
 *
 * @param occupied Universe → 已占用区间（会被并入新占用，调用方维护）。
 * @param width 通道数。
 * @param cursor 起点。
 * @returns 空位；找不到时为 `null`。
 */
function findSlotFrom(
  occupied: Map<number, [number, number][]>,
  width: number,
  cursor: PatchAddress,
): PatchAddress | null {
  if (width < 1 || width > DMX_CHANNELS) return null;
  for (let universe = Math.max(0, cursor.universe); universe <= MAX_UNIVERSE; universe += 1) {
    let candidate = universe === cursor.universe ? Math.max(1, cursor.address) : 1;
    const ranges = [...(occupied.get(universe) ?? [])].sort((a, b) => a[0] - b[0]);
    for (const [start, end] of ranges) {
      if (end < candidate) continue;
      if (start > candidate + width - 1) break;
      candidate = end + 1;
    }
    if (candidate + width - 1 <= DMX_CHANNELS) return { universe, address: candidate };
  }
  return null;
}

/**
 * 计算批量添加的计划（纯函数，不改工程）。
 *
 * @param project 工程（只读）。
 * @param model 要添加的模型。
 * @param options 选项。
 * @returns 计划；`items` 少于 `requested` 表示后面的放不下（Universe 用尽）。
 */
export function planAddFixtures(
  project: Pick<ShowProject, "fixtures" | "fixtureModels" | "stage">,
  model: FixtureModel,
  options: AddFixturesOptions,
): AddPlan {
  const modeId = options.modeId && model.modes?.some((m) => m.id === options.modeId) ? options.modeId : undefined;
  const width = footprintOf(model, modeId);
  const requested = Math.min(MAX_ADD_COUNT, Math.max(1, Math.floor(options.count) || 1));
  const gap = Math.min(MAX_ADD_GAP, Math.max(0, Math.floor(options.gap ?? 0) || 0));
  const template = options.nameTemplate?.trim() || `${model.name} ${NAME_PLACEHOLDER}`;
  const existing = project.fixtures.filter((f) => f.modelId === model.id).length;

  const occupied = new Map<number, [number, number][]>();
  for (const [u, spans] of spansByUniverse(project)) occupied.set(u, spans.map((s) => [s.range.start, s.range.end]));

  const given = options.start && options.start !== "auto" ? options.start : null;
  let cursor: PatchAddress = given
    ? {
        universe: Math.min(MAX_UNIVERSE, Math.max(0, Math.floor(given.universe) || 0)),
        address: Math.min(DMX_CHANNELS, Math.max(1, Math.floor(given.address) || 1)),
      }
    : { universe: project.fixtures.at(-1)?.universe ?? 0, address: 1 };

  const items: AddPlanItem[] = [];
  let shifted = false;
  for (let i = 0; i < requested; i += 1) {
    const slot = findSlotFrom(occupied, width, cursor);
    if (!slot) break;
    if (i === 0 && given && (slot.universe !== cursor.universe || slot.address !== cursor.address)) shifted = true;
    const list = occupied.get(slot.universe) ?? [];
    list.push([slot.address, slot.address + width - 1]);
    occupied.set(slot.universe, list);
    items.push({ name: formatFixtureName(template, existing + i + 1, requested > 1), universe: slot.universe, address: slot.address });
    cursor = { universe: slot.universe, address: slot.address + width + gap };
  }

  if (options.stagePoint) {
    const { x, y } = options.stagePoint;
    const offset = ((items.length - 1) * STAGE_ROW_SPACING_M) / 2;
    items.forEach((item, i) => {
      const p = clampToStage(project.stage, x - offset + i * STAGE_ROW_SPACING_M, y);
      item.stage = { x: Math.round(p.x * 100) / 100 + 0, y: Math.round(p.y * 100) / 100 + 0 };
    });
  }

  return { modelId: model.id, modeId, footprint: width, requested, items, ranges: mergeRanges(items, width), shifted };
}

/**
 * 把计划里的地址合并成连续区间（预览的“将占用 U0 13–60”）。
 *
 * @param items 计划里的灯。
 * @param width 每台的通道数。
 * @returns 区间，按 Universe、地址升序。
 */
function mergeRanges(items: readonly AddPlanItem[], width: number): AddPlanRange[] {
  const sorted = [...items].sort((a, b) => a.universe - b.universe || a.address - b.address);
  const out: AddPlanRange[] = [];
  for (const it of sorted) {
    const last = out.at(-1);
    const end = it.address + width - 1;
    if (last && last.universe === it.universe && it.address <= last.end + 1) last.end = Math.max(last.end, end);
    else out.push({ universe: it.universe, start: it.address, end });
  }
  return out;
}

/**
 * 把模型快照放进工程；已有同编号快照时以最新定义覆盖。
 *
 * @param draft 工程草稿。
 * @param model 素材库里的模型。
 */
export function upsertModel(draft: ShowProject, model: FixtureModel): void {
  const copy = structuredClone(model);
  const index = draft.fixtureModels.findIndex((m) => m.id === model.id);
  if (index >= 0) draft.fixtureModels[index] = copy;
  else draft.fixtureModels.push(copy);
}

/**
 * 执行计划：放入模型快照，按计划创建灯具，并为每台灯创建一条轨道。
 *
 * 计划里有舞台位置时，先把已有灯具的自动排布位置固定下来，避免新灯加入后旧灯“跳位”。
 *
 * @param draft 工程草稿。
 * @param model 模型（与计划的 `modelId` 一致）。
 * @param plan `planAddFixtures` 的结果（应基于同一个工程状态计算）。
 * @returns 新增灯具的 id（按添加顺序）。
 */
export function applyAddPlan(draft: ShowProject, model: FixtureModel, plan: AddPlan): string[] {
  if (plan.items.length === 0) return [];
  upsertModel(draft, model);
  if (plan.items.some((i) => i.stage)) materializePlacements(draft);
  const added: string[] = [];
  for (const item of plan.items) {
    const fixture: FixtureInstance = {
      id: newId(),
      name: item.name,
      modelId: model.id,
      universe: item.universe,
      address: item.address,
    };
    if (plan.modeId) fixture.modeId = plan.modeId;
    if (item.stage) fixture.stage = { x: item.stage.x, y: item.stage.y };
    draft.fixtures.push(fixture);
    draft.tracks.push({ id: newId(), target: { kind: "fixture", id: fixture.id }, mute: false, solo: false, lock: false });
    added.push(fixture.id);
  }
  return added;
}

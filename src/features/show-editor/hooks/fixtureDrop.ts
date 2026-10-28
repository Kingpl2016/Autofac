import { useFixtureStore } from "@/features/fixtures";
import { DMX_CHANNELS } from "../lib/project";
import { addModelToShow, type AddModelResult } from "./fixtureAddActions";

/** 舞台监视器的放置目标 id。 */
export const STAGE_DROP_ID = "stage";

/** Patch 里 Universe 卡片的放置目标 id 前缀（后接 Universe 编号）。 */
export const UNIVERSE_DROP_PREFIX = "universe:";

/** 舞台监视器放置目标携带的数据：把屏幕坐标换算成舞台坐标（米），落在舞台外时为 `null`。 */
export interface StageDropData {
  kind: "stage";
  toStagePoint: (clientX: number, clientY: number) => { x: number; y: number } | null;
}

/** Universe 卡片放置目标携带的数据。 */
export interface UniverseDropData {
  kind: "universe";
  universe: number;
  /** 按占用条 / 通道格的实际位置换算落点地址；卡片里没有可量的条时为 `null`（退回按卡片宽度近似） */
  addressAt?: (clientX: number, clientY: number) => number | null;
}

/** 灯具模型放下后的去处。 */
export type FixtureDropTarget =
  | { kind: "universe"; universe: number; address: number }
  | { kind: "stage"; point: { x: number; y: number } }
  | { kind: "timeline" };

/** dnd-kit 的放置目标（只取用到的字段，便于测试）。 */
export interface DropOver {
  id: string | number;
  rect: { left: number; width: number };
  data?: { current?: unknown };
}

/**
 * 判断灯具模型放在了哪里。
 *
 * Universe 卡片优先按占用条 / 通道格的实际位置换算起始地址，量不到时按指针在卡片里的横向位置近似（卡片宽度视为 512 个通道）；
 * 舞台按监视器的当前视图换算成舞台坐标。
 *
 * @param over 放置目标；没有时为 `null`。
 * @param pointer 松手时的指针（屏幕坐标）。
 * @param timelineId 时间线放置目标的 id。
 * @returns 去处；不是可放灯具的目标时为 `null`。
 */
export function resolveFixtureDrop(
  over: DropOver | null,
  pointer: { x: number; y: number },
  timelineId: string,
): FixtureDropTarget | null {
  if (!over) return null;
  if (over.id === timelineId) return { kind: "timeline" };
  const data = over.data?.current as StageDropData | UniverseDropData | undefined;
  if (data?.kind === "universe") {
    const exact = data.addressAt?.(pointer.x, pointer.y);
    if (exact != null) return { kind: "universe", universe: data.universe, address: Math.min(DMX_CHANNELS, Math.max(1, Math.floor(exact))) };
    const ratio = over.rect.width > 0 ? (pointer.x - over.rect.left) / over.rect.width : 0;
    const address = Math.min(DMX_CHANNELS, Math.max(1, 1 + Math.floor(Math.min(1, Math.max(0, ratio)) * DMX_CHANNELS)));
    return { kind: "universe", universe: data.universe, address };
  }
  if (data?.kind === "stage") {
    const point = data.toStagePoint(pointer.x, pointer.y);
    return point ? { kind: "stage", point } : null;
  }
  return null;
}

/**
 * 把拖来的灯具模型放进节目（一台）：Universe 卡片从落点地址起（被占用时顺延），
 * 舞台放在落点，时间线自动分配地址；都会新建轨道并选中新灯。
 *
 * @param modelId 模型编号。
 * @param target 去处。
 * @returns 添加结果；模型不在素材库里时为 `null`。
 */
export function dropFixtureModel(modelId: string, target: FixtureDropTarget): AddModelResult | null {
  const model = useFixtureStore.getState().models.find((m) => m.id === modelId);
  if (!model) return null;
  switch (target.kind) {
    case "universe":
      return addModelToShow(model, { count: 1, start: { universe: target.universe, address: target.address } });
    case "stage":
      return addModelToShow(model, { count: 1, stagePoint: target.point });
    case "timeline":
      return addModelToShow(model, { count: 1 });
  }
}

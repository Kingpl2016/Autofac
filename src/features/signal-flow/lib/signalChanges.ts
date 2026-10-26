import type { FlowList } from "./listModel";

/** 需要向读屏播报的对象：来源或目的地。 */
export interface SignalItem {
  /** 稳定的键，用于跨刷新比较。 */
  key: string;
  kind: "source" | "destination";
  /** 展示名（来源为 IP 或节目名，目的地为名称）。 */
  label: string;
  active: boolean;
}

/** 两次刷新之间“有信号”状态发生变化的对象。 */
export interface SignalChanges {
  gained: SignalItem[];
  lost: SignalItem[];
}

/**
 * 从列表数据里取出需要播报的对象（来源与目的地；Universe 数量太多，逐个播报会变成噪音）。
 *
 * @param list 列表数据。
 * @param playerName 回放节目名，回放伪源用它作展示名。
 * @returns 来源与目的地的当前状态。
 */
export function signalItems(list: FlowList, playerName: string): SignalItem[] {
  return [
    ...list.sources.map<SignalItem>((s) => ({
      key: `src:${s.ip}`,
      kind: "source",
      label: s.isPlayer ? playerName : s.ip,
      active: s.active,
    })),
    ...list.destinations.map<SignalItem>((d) => ({
      key: `dst:${d.id}`,
      kind: "destination",
      label: d.name,
      active: d.active,
    })),
  ];
}

/**
 * 比较上一次与这一次的状态，找出“有信号”发生变化的对象。
 *
 * 第一次（没有上一次）不产生任何变化，避免打开页面就播报一长串；
 * 新出现且有信号的对象算作“有信号”，消失的、原先有信号的对象算作“信号中断”。
 *
 * @param prev 上一次的对象（以 `key` 为键）；`null` 表示还没有上一次。
 * @param next 这一次的对象。
 * @returns 新增信号与信号中断的对象。
 */
export function diffSignal(
  prev: ReadonlyMap<string, SignalItem> | null,
  next: readonly SignalItem[],
): SignalChanges {
  const changes: SignalChanges = { gained: [], lost: [] };
  if (!prev) return changes;
  const seen = new Set<string>();
  for (const item of next) {
    seen.add(item.key);
    const before = prev.get(item.key)?.active ?? false;
    if (item.active && !before) changes.gained.push(item);
    else if (!item.active && before) changes.lost.push(item);
  }
  for (const [key, item] of prev) {
    if (!seen.has(key) && item.active) changes.lost.push({ ...item, active: false });
  }
  return changes;
}
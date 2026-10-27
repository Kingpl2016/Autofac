/** 一组预设。 */
export interface PresetGroup<T> {
  /** 分组 key。 */
  key: string;
  /** 组内的预设，保持原有顺序。 */
  items: T[];
}

/**
 * 按 `group` 字段分组。
 *
 * @param items 预设列表（已排序）。
 * @param fallback 没有 group 的预设归入的分组 key。
 * @param last 需要固定排在最后的分组 key，按给定顺序排列；默认只有 fallback。
 * @returns 分组后的列表；其余组的顺序与各组第一个预设在原列表中的顺序一致。
 */
export function groupPresets<T extends { group?: string }>(
  items: readonly T[],
  fallback = "more",
  last: readonly string[] = [fallback],
): PresetGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = item.group ?? fallback;
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }
  const rank = (key: string) => {
    const index = last.indexOf(key);
    return index === -1 ? 0 : 1 + index;
  };
  // 稳定排序：不在 last 里的组保持原顺序，在 last 里的组依次排到最后
  return [...groups].map(([key, list]) => ({ key, items: list })).toSorted((a, b) => rank(a.key) - rank(b.key));
}
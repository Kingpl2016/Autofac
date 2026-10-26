/**
 * 在“可见项”之间移动一个条目：与上一个（或下一个）可见项交换位置。
 *
 * 列表里可能夹着被隐藏的条目（如 sACN 关闭时的 sACN 目的地）；移动只看可见邻居，
 * 隐藏条目保持各自相对位置，不会因为用户的一次上移 / 下移而被打乱。
 *
 * @param list 完整列表。
 * @param id 要移动的条目 id。
 * @param direction `-1` 上移，`1` 下移。
 * @param isVisible 判断条目当前是否可见。
 * @returns 新列表；条目不存在、已在可见区域的边界时原样返回同一个数组。
 */
export function moveWithin<T extends { id: string }>(
  list: readonly T[],
  id: string,
  direction: -1 | 1,
  isVisible: (item: T) => boolean = () => true,
): readonly T[] {
  const from = list.findIndex((x) => x.id === id);
  if (from < 0) return list;
  let to = from + direction;
  while (to >= 0 && to < list.length && !isVisible(list[to])) to += direction;
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/**
 * 条目在可见项里是否还能移动。
 *
 * @param list 完整列表。
 * @param id 条目 id。
 * @param direction `-1` 上移，`1` 下移。
 * @param isVisible 判断条目当前是否可见。
 * @returns 能移动为 `true`。
 */
export function canMove<T extends { id: string }>(
  list: readonly T[],
  id: string,
  direction: -1 | 1,
  isVisible: (item: T) => boolean = () => true,
): boolean {
  return moveWithin(list, id, direction, isVisible) !== list;
}
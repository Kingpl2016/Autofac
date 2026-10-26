import type { Node, XYPosition } from "@xyflow/react";

/**
 * 用新一轮构图的节点更新画布上的节点，同时保留两类信息：
 *
 * - 用户拖拽过的节点保持拖拽后的位置，其余节点跟随新布局（来源增减时不会重叠）；
 * - 已经测量过的尺寸，避免每次数据刷新都让画布重新测量全部节点。
 *
 * @param prev 画布上当前的节点。
 * @param next 新一轮构图产生的节点。
 * @param dragged 用户拖拽过的节点位置（键为节点 id）。
 * @returns 合并后的节点列表。
 */
export function mergeNodes(
  prev: readonly Node[],
  next: readonly Node[],
  dragged: Readonly<Record<string, XYPosition>>,
): Node[] {
  const byId = new Map(prev.map((n) => [n.id, n]));
  return next.map((n) => {
    const old = byId.get(n.id);
    const position = dragged[n.id] ?? n.position;
    if (!old) return position === n.position ? n : { ...n, position };
    return { ...n, position, measured: old.measured, width: old.width, height: old.height };
  });
}
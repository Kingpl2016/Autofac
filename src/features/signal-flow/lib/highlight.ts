/** 参与高亮的节点与边的 id 集合。 */
export interface Related {
  nodes: ReadonlySet<string>;
  edges: ReadonlySet<string>;
}

/** 悬停的目标：一个节点或一条边。 */
export type HoverTarget = { kind: "node" | "edge"; id: string };

interface GraphLike {
  nodes: readonly { id: string }[];
  edges: readonly { id: string; source: string; target: string }[];
}

/** 沿边方向收集从 `start` 出发可到达的所有节点（含自身）。 */
function reach(
  start: string,
  edges: GraphLike["edges"],
  next: (e: GraphLike["edges"][number]) => [from: string, to: string],
): Set<string> {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const cur = queue.pop() as string;
    for (const e of edges) {
      const [from, to] = next(e);
      if (from === cur && !seen.has(to)) {
        seen.add(to);
        queue.push(to);
      }
    }
  }
  return seen;
}

/**
 * 计算悬停目标的“关联路径”：它的全部上游与下游节点，以及连接这些节点的边。
 *
 * 悬停节点时，上游指所有能流到它的来源，下游指它能流向的所有目的地；
 * 悬停边时，取该边起点的上游、终点的下游，再加上这条边本身。
 * 用于高亮关联路径、压暗其余部分。
 *
 * @param graph 当前图（节点与边）。
 * @param target 悬停目标。
 * @returns 关联的节点 id 与边 id；目标不在图中时返回只含目标自身的集合。
 */
export function relatedTo(graph: GraphLike, target: HoverTarget): Related {
  const edgeOf = (id: string) => graph.edges.find((e) => e.id === id);
  let upstreamFrom: string;
  let downstreamFrom: string;
  const extraEdges = new Set<string>();

  if (target.kind === "node") {
    upstreamFrom = target.id;
    downstreamFrom = target.id;
  } else {
    const e = edgeOf(target.id);
    if (!e) return { nodes: new Set(), edges: new Set([target.id]) };
    upstreamFrom = e.source;
    downstreamFrom = e.target;
    extraEdges.add(e.id);
  }

  const upstream = reach(upstreamFrom, graph.edges, (e) => [e.target, e.source]);
  const downstream = reach(downstreamFrom, graph.edges, (e) => [e.source, e.target]);

  const nodes = new Set([...upstream, ...downstream]);
  const edges = new Set(extraEdges);
  for (const e of graph.edges) {
    if (
      (upstream.has(e.source) && upstream.has(e.target)) ||
      (downstream.has(e.source) && downstream.has(e.target))
    ) {
      edges.add(e.id);
    }
  }
  return { nodes, edges };
}
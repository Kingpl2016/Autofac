import { FlowEdge } from "../components/FlowEdge";
import { SourceNode, UniverseNode, DestinationNode, PlayerNode } from "../components/nodes";

/** React Flow 节点类型映射。 */
export const nodeTypes = {
  source: SourceNode,
  player: PlayerNode,
  universe: UniverseNode,
  destination: DestinationNode,
};

/** React Flow 边类型映射。 */
export const edgeTypes = {
  flow: FlowEdge,
};
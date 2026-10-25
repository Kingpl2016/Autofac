import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Radio, Grid3x3, Forward, Boxes, Film } from "lucide-react";

import { cn } from "@/lib/utils";
import { useProtocolFlags } from "@/features/settings";

const CARD =
  "rounded-md border bg-card px-3 py-2 text-xs shadow-sm w-44";

/** 源节点（输入列）。 */
export function SourceNode({ data }: NodeProps) {
  const d = data as { ip: string; universeCount: number };
  return (
    <div className={cn(CARD, "border-chart-2/60")}>
      <div className="flex items-center gap-1.5 font-medium">
        <Radio className="size-3.5 text-chart-2" aria-hidden />
        <span className="tabular truncate">{d.ip}</span>
      </div>
      <div className="mt-0.5 text-muted-foreground">
        {d.universeCount} universes
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

/** 回放源节点（输入列）：来自录制节目的信号。 */
export function PlayerNode({ data }: NodeProps) {
  const d = data as { name: string; universeCount: number };
  return (
    <div className={cn(CARD, "border-warning/60")}>
      <div className="flex items-center gap-1.5 font-medium">
        <Film className="size-3.5 text-warning" aria-hidden />
        <span className="truncate">{d.name || "Player"}</span>
      </div>
      <div className="mt-0.5 text-muted-foreground">
        {d.universeCount} universes
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

/** Universe 节点（处理列），支持聚合态。 */
export function UniverseNode({ data }: NodeProps) {
  const d = data as {
    universe: number;
    sourceCount: number;
    aggregate?: boolean;
    totalUniverses?: number;
  };
  return (
    <div className={cn(CARD, "border-primary/60")}>
      <div className="flex items-center gap-1.5 font-medium">
        {d.aggregate ? (
          <Boxes className="size-3.5 text-primary" aria-hidden />
        ) : (
          <Grid3x3 className="size-3.5 text-primary" aria-hidden />
        )}
        <span className="tabular">
          {d.aggregate ? `${d.totalUniverses} universes` : `Universe ${d.universe}`}
        </span>
      </div>
      <div className="mt-0.5 text-muted-foreground">
        {d.sourceCount} sources
      </div>
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

/** 目的地节点（输出列）。 */
export function DestinationNode({ data }: NodeProps) {
  const d = data as {
    name: string;
    ip: string;
    protocol: string;
    mode: string;
    enabled: boolean;
  };
  const { sacnEnabled } = useProtocolFlags();
  return (
    <div
      className={cn(
        CARD,
        d.enabled ? "border-chart-3/60" : "border-border opacity-60",
      )}
    >
      <div className="flex items-center gap-1.5 font-medium">
        <Forward className="size-3.5 text-chart-3" aria-hidden />
        <span className="truncate">{d.name || "—"}</span>
      </div>
      <div className="tabular mt-0.5 text-muted-foreground">
        {sacnEnabled ? `${d.ip} · ${d.protocol === "sacn" ? "sACN" : "Art-Net"}` : d.ip}
      </div>
      <Handle type="target" position={Position.Left} />
    </div>
  );
}

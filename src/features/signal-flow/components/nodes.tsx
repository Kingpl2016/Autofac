import { useContext, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Radio, Grid3x3, Forward, Boxes, Film, Timer } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ConflictBadge } from "@/shared/components/ConflictBadge";
import { formatPacketRate } from "@/shared/lib/format";
import { useProtocolFlags } from "@/features/settings";
import type { FlowProtocol } from "../lib/activity";
import { FlowDisplayContext } from "../lib/flowContext";
import type {
  DestinationNodeData,
  PlayerNodeData,
  SourceNodeData,
  UniverseNodeData,
} from "../lib/graphModel";

interface NodeShellProps {
  id: string;
  /** 左侧色条的类名（决定节点种类的颜色）。 */
  accent: string;
  /** 是否正有信号：边框发绿并显示脉冲圆点。 */
  active: boolean;
  /** 停用：整体变淡。 */
  muted?: boolean;
  hasTarget?: boolean;
  hasSource?: boolean;
  children: ReactNode;
}

/**
 * 节点外壳：左侧 4px 种类色条、有信号时的绿色描边与圆点、悬停高亮时的压暗。
 *
 * 有信号这一状态同时用圆点和读屏文字表达，不只靠颜色。
 */
function NodeShell({
  id,
  accent,
  active,
  muted,
  hasTarget,
  hasSource,
  children,
}: NodeShellProps) {
  const { related } = useContext(FlowDisplayContext);
  const dimmed = related !== null && !related.nodes.has(id);
  return (
    <div
      className={cn(
        "relative w-56 overflow-hidden rounded-md border bg-card py-2 pl-4 pr-3 text-xs shadow-sm transition-opacity duration-150",
        active ? "border-success/60 shadow-[0_0_10px_-3px_var(--success)]" : "border-border",
        muted && "opacity-60",
        dimmed && "opacity-25",
      )}
    >
      <span className={cn("absolute inset-y-0 left-0 w-1", accent)} aria-hidden />
      {children}
      {hasTarget && <Handle type="target" position={Position.Left} />}
      {hasSource && <Handle type="source" position={Position.Right} />}
    </div>
  );
}

/** 标题行：图标 + 标题 +（可选）右侧徽标 + 有信号圆点。 */
function Title({
  icon,
  active,
  children,
  extra,
}: {
  icon: ReactNode;
  active: boolean;
  children: ReactNode;
  extra?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-1.5 font-medium">
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {extra}
      {active && (
        <>
          <span
            className="size-2 shrink-0 rounded-full bg-success motion-safe:animate-pulse"
            aria-hidden
          />
          <span className="sr-only">{t("signalFlow.node.hasSignal")}</span>
        </>
      )}
    </div>
  );
}

function useProtocolLabel() {
  const { t } = useTranslation();
  const { sacnEnabled } = useProtocolFlags();
  /** sACN 关闭时只可能是 Art-Net，协议名没有信息量，直接省略。 */
  return (p: FlowProtocol): string | null => {
    if (!sacnEnabled) return null;
    return t(`signalFlow.protocol.${p}`);
  };
}

const SUB = "mt-0.5 truncate text-muted-foreground";

/** 源节点（输入列）。 */
export function SourceNode({ id, data }: NodeProps) {
  const { t } = useTranslation();
  const protocolLabel = useProtocolLabel();
  const d = data as SourceNodeData;
  const parts = [
    protocolLabel(d.protocol),
    t("signalFlow.node.universes", { n: d.universeCount }),
    `${formatPacketRate(d.packetRate).value} pps`,
  ].filter(Boolean);
  return (
    <NodeShell id={id} accent="bg-chart-2" active={d.active} hasSource>
      <Title icon={<Radio className="size-3.5 text-chart-2" aria-hidden />} active={d.active}>
        <span className="tabular">{d.ip}</span>
      </Title>
      <div className={cn(SUB, "tabular")}>{parts.join(" · ")}</div>
    </NodeShell>
  );
}

/** 回放源节点（输入列）：来自录制节目的信号。 */
export function PlayerNode({ id, data }: NodeProps) {
  const { t } = useTranslation();
  const d = data as PlayerNodeData;
  return (
    <NodeShell id={id} accent="bg-warning" active={d.active} hasSource>
      <Title icon={<Film className="size-3.5 text-warning" aria-hidden />} active={d.active}>
        {d.name || t("signalFlow.node.player")}
      </Title>
      <div className={cn(SUB, "tabular")}>
        {t("signalFlow.node.universes", { n: d.universeCount })}
      </div>
    </NodeShell>
  );
}

/** Universe 节点（处理列），支持聚合态。 */
export function UniverseNode({ id, data }: NodeProps) {
  const { t } = useTranslation();
  const protocolLabel = useProtocolLabel();
  const d = data as UniverseNodeData;

  if (d.aggregate) {
    const total = d.totalUniverses ?? 0;
    const active = d.activeUniverses ?? 0;
    const pct = total > 0 ? Math.round((active / total) * 100) : 0;
    return (
      <NodeShell id={id} accent="bg-primary" active={d.active} hasTarget hasSource>
        <Title icon={<Boxes className="size-3.5 text-primary" aria-hidden />} active={d.active}>
          <span className="tabular">{t("signalFlow.node.aggregate", { n: total })}</span>
        </Title>
        <div className={cn(SUB, "tabular")}>
          {t("signalFlow.node.aggregateActive", {
            active,
            rate: formatPacketRate(d.packetRate).value,
          })}
        </div>
        <div
          role="progressbar"
          aria-label={t("signalFlow.node.aggregateProgress")}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={active}
          className="mt-1.5 h-1 overflow-hidden rounded-full bg-secondary"
        >
          <div className="h-full bg-success transition-[width] duration-300" style={{ width: `${pct}%` }} />
        </div>
      </NodeShell>
    );
  }

  const parts = [
    `${formatPacketRate(d.packetRate).value} pps`,
    t("signalFlow.node.sources", { n: d.sourceCount }),
    t("signalFlow.node.channels", { n: d.activeChannels }),
  ];
  const protocol = protocolLabel(d.protocol);
  return (
    <NodeShell id={id} accent="bg-primary" active={d.active} hasTarget hasSource>
      <Title
        icon={<Grid3x3 className="size-3.5 text-primary" aria-hidden />}
        active={d.active}
        extra={protocol && <span className="shrink-0 font-normal text-muted-foreground">{protocol}</span>}
      >
        <span className="tabular">{t("dashboard.universeN", { n: d.universe })}</span>
      </Title>
      <div className={cn(SUB, "tabular")}>{parts.join(" · ")}</div>
      {d.conflict !== "none" && (
        <div className="mt-1">
          <ConflictBadge level={d.conflict} channels={d.conflictChannels} />
        </div>
      )}
    </NodeShell>
  );
}

/** 带正负号的偏移文字：`+100`、`-20`。 */
function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

/** 目的地节点（输出列）。 */
export function DestinationNode({ id, data }: NodeProps) {
  const { t } = useTranslation();
  const { sacnEnabled } = useProtocolFlags();
  const d = data as DestinationNodeData;
  const address = `${d.ip}:${d.port}`;
  const route = [
    d.mode === "all" ? t("forwarding.modeAll") : t("forwarding.modeSelected"),
    d.universeOffset !== 0 && t("signalFlow.node.offset", { n: signed(d.universeOffset) }),
  ].filter(Boolean);
  return (
    <NodeShell id={id} accent="bg-chart-3" active={d.active} muted={!d.enabled} hasTarget>
      <Title
        icon={<Forward className="size-3.5 text-chart-3" aria-hidden />}
        active={d.active}
        extra={
          <>
            {!d.enabled && <Badge variant="destructive">{t("signalFlow.node.off")}</Badge>}
            {d.delayMs > 0 && (
              <Badge variant="outline" className="tabular gap-0.5">
                <Timer className="size-3" aria-hidden />
                {d.delayMs}ms
              </Badge>
            )}
          </>
        }
      >
        {d.name || "—"}
      </Title>
      <div className={cn(SUB, "tabular")}>
        {sacnEnabled ? `${d.protocol === "sacn" ? "sACN" : "Art-Net"} → ${address}` : address}
      </div>
      <div className={SUB}>{route.join(" · ")}</div>
    </NodeShell>
  );
}
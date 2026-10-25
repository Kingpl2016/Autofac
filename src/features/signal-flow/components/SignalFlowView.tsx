import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ReactFlow,
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/shared/components/PageHeader";
import { useEngineDataStore } from "@/shared/stores/engineDataStore";
import { useForwardingQuery } from "@/features/forwarding/hooks/useForwarding";
import { usePlayerStore } from "@/features/recording";
import { nodeTypes } from "../lib/nodeTypes";
import { playerDestinations, playerUniverses } from "../lib/playerSource";
import { buildGraph } from "../lib/graphModel";

/** 是否启用 reduced-motion。 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handler = () => setReduced(mq.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return reduced;
}

/** 以新布局合并旧位置，保留用户拖拽后的坐标。 */
function mergePositions(prev: Node[], next: Node[]): Node[] {
  const posById = new Map(prev.map((n) => [n.id, n.position]));
  return next.map((n) => {
    const p = posById.get(n.id);
    return p ? { ...n, position: p } : n;
  });
}

/**
 * 信号流页：三列 源 → Universe → 目的地 有向图，活跃边动画、禁用边虚线，
 * Universe 超阈值时聚合。
 */
export function SignalFlowView() {
  const { t } = useTranslation();
  const liveUniverses = useEngineDataStore((s) => s.universes);
  const playback = usePlayerStore((s) => s.status);
  const forwarding = useForwardingQuery();
  const forwardingDestinations = useMemo(
    () => forwarding.data?.destinations ?? [],
    [forwarding.data],
  );
  const reduced = usePrefersReducedMotion();
  const [threshold, setThreshold] = useState(50);

  // 回放模式下实时接收已暂停：图上改为展示"回放源 → Universe → 目的地"
  const inPlayback = playback.loaded;
  const universes = useMemo(
    () => (inPlayback ? playerUniverses(playback) : liveUniverses),
    [inPlayback, playback, liveUniverses],
  );
  const destinations = useMemo(
    () =>
      inPlayback
        ? playerDestinations(playback, forwardingDestinations)
        : forwardingDestinations,
    [inPlayback, playback, forwardingDestinations],
  );
  // 暂停 / 停止的回放不应有流动动画
  const animateEdges = !reduced && (!inPlayback || playback.state === "playing");

  const graph = useMemo(
    () => buildGraph(universes, destinations, threshold, animateEdges, playback.name),
    [universes, destinations, threshold, animateEdges, playback.name],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  useEffect(() => {
    setNodes((prev) => mergePositions(prev, graph.nodes));
    setEdges(graph.edges);
  }, [graph, setNodes, setEdges]);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t("nav.signalFlow")}
        subtitle={t("signalFlow.subtitle")}
        actions={
          <div className="flex items-center gap-2">
            {graph.simplified && (
              <Badge variant="warning">{t("signalFlow.simplified")}</Badge>
            )}
            <Label htmlFor="simplify" className="text-xs text-muted-foreground">
              {t("signalFlow.simplifyThreshold")}
            </Label>
            <Input
              id="simplify"
              type="number"
              className="tabular w-20"
              value={threshold}
              onChange={(e) => setThreshold(Math.max(1, Number(e.target.value) || 1))}
            />
          </div>
        }
      />

      <div className="flex items-center gap-4 pb-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="h-px w-5 bg-primary" /> {t("signalFlow.active")}
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="h-px w-5"
            style={{
              backgroundImage:
                "repeating-linear-gradient(90deg, var(--muted-foreground) 0 3px, transparent 3px 6px)",
            }}
          />
          {t("signalFlow.disabled")}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border">
        {universes.length === 0 && destinations.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {t("signalFlow.empty")}
          </div>
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodeTypes={nodeTypes}
            fitView
            proOptions={{ hideAttribution: true }}
            colorMode="dark"
          >
            <Background />
            <Controls />
          </ReactFlow>
        )}
      </div>
    </div>
  );
}

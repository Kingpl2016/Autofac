import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Edge,
  type Node,
  type XYPosition,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { List, RotateCcw, Workflow } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/shared/components/PageHeader";
import { Segmented } from "@/shared/components/Segmented";
import { useMediaQuery } from "@/shared/hooks/useMediaQuery";
import { MEDIA_REDUCED_MOTION } from "@/shared/lib/breakpoints";
import { useEngineDataStore } from "@/shared/stores/engineDataStore";
import { useOutputStore } from "@/shared/stores/outputStore";
import { useResolvedMode } from "@/features/appearance";
import { useForwardingQuery } from "@/features/forwarding";
import { usePlayerStore } from "@/features/recording";
import { useProtocolFlags, useSettingsQuery } from "@/features/settings";
import { useAnnounceSignal } from "../hooks/useAnnounceSignal";
import { useStableValue } from "../hooks/useStableValue";
import { FlowDisplayContext, type FlowDisplay } from "../lib/flowContext";
import { buildGraph, type FlowEdgeData } from "../lib/graphModel";
import { relatedTo, type HoverTarget } from "../lib/highlight";
import { buildFlowList } from "../lib/listModel";
import { mergeNodes } from "../lib/mergeNodes";
import { shouldAnimateParticles } from "../lib/motion";
import { edgeTypes, nodeTypes } from "../lib/nodeTypes";
import { playerDestinations, playerUniverses } from "../lib/playerSource";
import { signalItems } from "../lib/signalChanges";
import { useSignalFlowPrefs, type FlowViewMode } from "../stores/useSignalFlowPrefs";
import { FlowLegend } from "./FlowLegend";
import { FlowListView } from "./FlowListView";

/**
 * 信号流页：三列 来源 → Universe → 目的地 有向图。
 *
 * 有信号的节点发绿光并带圆点，有信号的边画实线与流动粒子，无信号或停用的边画虚线；
 * 悬停时高亮关联路径、压暗其余；Universe 数达到阈值时聚合；
 * “减少动态效果”下不画粒子与脉冲。
 */
export function SignalFlowView() {
  return (
    <ReactFlowProvider>
      <SignalFlowContent />
    </ReactFlowProvider>
  );
}

function SignalFlowContent() {
  const { t } = useTranslation();
  const theme = useResolvedMode();
  const liveUniverses = useEngineDataStore((s) => s.universes);
  const playback = usePlayerStore((s) => s.status);
  const forwarding = useForwardingQuery();
  const { sacnEnabled } = useProtocolFlags();
  const { data: settings } = useSettingsQuery();
  const output = useOutputStore((s) => s.output);
  const threshold = useSignalFlowPrefs((s) => s.simplifyThreshold);
  const setThreshold = useSignalFlowPrefs((s) => s.setSimplifyThreshold);
  const view = useSignalFlowPrefs((s) => s.view);
  const setView = useSignalFlowPrefs((s) => s.setView);
  const hintId = useId();
  const reduced = useMediaQuery(MEDIA_REDUCED_MOTION, false);
  const { fitView } = useReactFlow();

  const forwardingDestinations = useMemo(
    () => forwarding.data?.destinations ?? [],
    [forwarding.data],
  );

  // 回放模式下实时接收已暂停：图上改为展示“回放源 → Universe → 目的地”
  const inPlayback = playback.loaded;
  const universes = useMemo(
    () => (inPlayback ? playerUniverses(playback) : liveUniverses),
    [inPlayback, playback, liveUniverses],
  );
  const destinations = useMemo(() => {
    const all = inPlayback
      ? playerDestinations(playback, forwardingDestinations)
      : forwardingDestinations;
    // sACN 关闭时后端不会向 sACN 目的地发送，图上也不显示
    return sacnEnabled ? all : all.filter((d) => d.protocol !== "sacn");
  }, [inPlayback, playback, forwardingDestinations, sacnEnabled]);
  const destStats = useMemo(
    () => new Map((output?.destinations ?? []).map((d) => [d.id, { sentRate: d.sentRate }])),
    [output],
  );

  // 暂停 / 停止的回放没有信号
  const playerActive = inPlayback && playback.state === "playing";
  const mergeMode = settings?.merge.mode ?? "htp";

  const graph = useMemo(
    () =>
      buildGraph(universes, destinations, {
        simplifyThreshold: threshold,
        playerName: playback.name,
        playerActive,
        mergeMode,
        destStats,
      }),
    [universes, destinations, threshold, playback.name, playerActive, mergeMode, destStats],
  );
  // 列表视图不做聚合，Universe 再多也逐行列出；只在列表视图时才计算
  const list = useMemo(
    () =>
      view === "list"
        ? buildFlowList(universes, destinations, { playerActive, mergeMode, destStats })
        : null,
    [view, universes, destinations, playerActive, mergeMode, destStats],
  );
  const items = useMemo(() => (list ? signalItems(list, playback.name) : null), [list, playback.name]);
  useAnnounceSignal(items);
  // 引擎每 100ms 推一次快照，但图的内容通常没变：内容不变就沿用上一个对象，
  // 不去重新协调整张图
  const stable = useStableValue(graph, JSON.stringify([graph.nodes, graph.edges]));

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [dragged, setDragged] = useState<Record<string, XYPosition>>({});
  const [hover, setHover] = useState<HoverTarget | null>(null);
  const [thresholdDraft, setThresholdDraft] = useState<string | null>(null);

  useEffect(() => {
    setNodes((prev) => mergeNodes(prev, stable.nodes, dragged));
    setEdges(stable.edges);
  }, [stable, dragged, setNodes, setEdges]);

  const activeEdges = useMemo(
    () => stable.edges.filter((e) => (e.data as FlowEdgeData | undefined)?.active).length,
    [stable],
  );
  const related = useMemo(() => (hover ? relatedTo(stable, hover) : null), [hover, stable]);
  const display = useMemo<FlowDisplay>(
    () => ({ related, particles: shouldAnimateParticles(reduced, activeEdges) }),
    [related, reduced, activeEdges],
  );

  const resetLayout = useCallback(() => {
    setDragged({});
    // 等排版状态落到画布上之后再适配视图
    requestAnimationFrame(() =>
      requestAnimationFrame(() => void fitView({ duration: reduced ? 0 : 250 })),
    );
  }, [fitView, reduced]);

  const empty = universes.length === 0 && destinations.length === 0;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t("nav.signalFlow")}
        subtitle={t("signalFlow.subtitle")}
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Segmented<FlowViewMode>
              size="md"
              value={view}
              onChange={setView}
              ariaLabel={t("signalFlow.view.label")}
              options={[
                {
                  value: "graph",
                  label: t("signalFlow.view.graph"),
                  icon: <Workflow className="size-3.5" aria-hidden />,
                },
                {
                  value: "list",
                  label: t("signalFlow.view.list"),
                  icon: <List className="size-3.5" aria-hidden />,
                },
              ]}
            />
            {view === "graph" && (
              <>
                {stable.simplified && <Badge variant="warning">{t("signalFlow.simplified")}</Badge>}
                <Label htmlFor="simplify" className="text-xs text-muted-foreground">
                  {t("signalFlow.simplifyThreshold")}
                </Label>
                <Input
                  id="simplify"
                  type="number"
                  min={1}
                  max={9999}
                  className="tabular h-10 w-20"
                  title={t("signalFlow.thresholdHint")}
                  value={thresholdDraft ?? threshold}
                  onChange={(e) => {
                    setThresholdDraft(e.target.value);
                    const n = Number(e.target.value);
                    if (e.target.value !== "" && Number.isFinite(n)) setThreshold(n);
                  }}
                  onBlur={() => setThresholdDraft(null)}
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={resetLayout}
                  disabled={empty}
                  title={t("signalFlow.resetLayoutHint")}
                >
                  <RotateCcw />
                  {t("signalFlow.resetLayout")}
                </Button>
              </>
            )}
          </div>
        }
      />

      {view === "graph" && <FlowLegend />}

      <div
        role="region"
        aria-label={view === "graph" ? t("signalFlow.canvasLabel") : t("signalFlow.view.list")}
        aria-describedby={view === "graph" ? hintId : undefined}
        className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border"
      >
        <p id={hintId} className="sr-only">
          {t("signalFlow.canvasHint")}
        </p>
        {empty ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {t("signalFlow.empty")}
          </div>
        ) : list ? (
          <FlowListView list={list} showProtocol={sacnEnabled} playerName={playback.name} />
        ) : (
          <FlowDisplayContext.Provider value={display}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodeDragStop={(_, node) =>
                setDragged((d) => ({ ...d, [node.id]: node.position }))
              }
              onNodeMouseEnter={(_, node) => setHover({ kind: "node", id: node.id })}
              onNodeMouseLeave={() => setHover(null)}
              onEdgeMouseEnter={(_, edge) => setHover({ kind: "edge", id: edge.id })}
              onEdgeMouseLeave={() => setHover(null)}
              nodesConnectable={false}
              // 这是只读的可视化：Delete / Backspace 不应把选中的节点从图上删掉
              deleteKeyCode={null}
              minZoom={0.2}
              fitView
              proOptions={{ hideAttribution: true }}
              colorMode={theme}
            >
              {/* 不放右下角的小地图：它盖住画布一角，三列布局用缩放 / 适应视图就能看全 */}
              <Background />
              <Controls />
            </ReactFlow>
          </FlowDisplayContext.Provider>
        )}
      </div>
    </div>
  );
}
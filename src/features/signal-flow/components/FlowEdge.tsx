import { useContext } from "react";
import { BaseEdge, getBezierPath, type EdgeProps } from "@xyflow/react";

import { FlowDisplayContext } from "../lib/flowContext";
import type { FlowEdgeData } from "../lib/graphModel";
import { particleDuration } from "../lib/motion";

/** 每条有信号的边上同时跑的粒子数；相位均匀错开。 */
const PARTICLES = 2;

/**
 * 信号流的边：有信号画成实线并带流动粒子，无信号或目的地停用画成虚线。
 *
 * 粒子用 SVG 动画（`animateMotion`）按时间匀速移动，不依赖帧率；
 * “减少动态效果”或有信号的边过多时，由上层通过上下文关闭粒子。
 * 悬停高亮时关联边加粗，其余边压暗。
 */
export function FlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps) {
  const { related, particles } = useContext(FlowDisplayContext);
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const d = data as FlowEdgeData | undefined;
  const active = d?.active ?? false;
  const highlighted = related?.edges.has(id) ?? false;
  const dimmed = related !== null && !highlighted;
  const trip = particleDuration(targetX - sourceX);

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: active ? "var(--primary)" : "var(--muted-foreground)",
          strokeWidth: highlighted ? 2.5 : 1.5,
          strokeDasharray: active ? undefined : "4 4",
          opacity: dimmed ? 0.15 : active ? 1 : 0.7,
          transition: "opacity 150ms, stroke-width 150ms",
        }}
      />
      {active &&
        particles &&
        !dimmed &&
        Array.from({ length: PARTICLES }, (_, i) => (
          <circle key={i} r={2.5} fill="var(--primary)" data-testid="flow-particle">
            <animateMotion
              dur={`${trip}s`}
              // 负的起始时间让各粒子一开始就处于不同相位，而不是挤在起点
              begin={`${-(i / PARTICLES) * trip}s`}
              repeatCount="indefinite"
              path={path}
            />
          </circle>
        ))}
    </>
  );
}
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Position, type EdgeProps } from "@xyflow/react";

import { FlowDisplayContext, type FlowDisplay } from "../../lib/flowContext";
import type { FlowEdgeData } from "../../lib/graphModel";
import { FlowEdge } from "../FlowEdge";

afterEach(() => cleanup());

function renderEdge(data: FlowEdgeData, display: FlowDisplay, id = "e1") {
  const props = {
    id,
    sourceX: 0,
    sourceY: 0,
    targetX: 360,
    targetY: 100,
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    data,
  } as unknown as EdgeProps;
  return render(
    <FlowDisplayContext.Provider value={display}>
      <svg>
        <FlowEdge {...props} />
      </svg>
    </FlowDisplayContext.Provider>,
  );
}

const basePath = (c: HTMLElement) => c.querySelector("path.react-flow__edge-path") as SVGPathElement;
const NONE: FlowDisplay = { related: null, particles: true };

describe("FlowEdge", () => {
  it("有信号：实线，并带 2 个相位错开的粒子", () => {
    const { container } = renderEdge({ active: true, disabled: false }, NONE);
    const path = basePath(container);
    expect(path.style.strokeDasharray).toBe("");
    expect(path.style.stroke).toBe("var(--primary)");

    const particles = screen.getAllByTestId("flow-particle");
    expect(particles).toHaveLength(2);
    const motions = particles.map((p) => p.querySelector("animateMotion") as Element);
    // 同一时长、相位不同（第二个粒子起始时间为负，处于路径中段）
    expect(motions[0].getAttribute("dur")).toBe(motions[1].getAttribute("dur"));
    expect(motions[0].getAttribute("begin")).not.toBe(motions[1].getAttribute("begin"));
    expect(motions[1].getAttribute("begin")?.startsWith("-")).toBe(true);
    expect(motions[0].getAttribute("repeatCount")).toBe("indefinite");
    expect(motions[0].getAttribute("path")).toBe(path.getAttribute("d"));
  });

  it("时长与边的水平跨度成正比（360px → 3 秒）", () => {
    renderEdge({ active: true, disabled: false }, NONE);
    const dur = screen.getAllByTestId("flow-particle")[0].querySelector("animateMotion");
    expect(dur?.getAttribute("dur")).toBe("3s");
  });

  it("无信号：虚线，没有粒子", () => {
    const { container } = renderEdge({ active: false, disabled: false }, NONE);
    expect(basePath(container).style.strokeDasharray).toBe("4 4");
    expect(screen.queryAllByTestId("flow-particle")).toHaveLength(0);
  });

  it("目的地停用：虚线，没有粒子", () => {
    renderEdge({ active: false, disabled: true }, NONE);
    expect(screen.queryAllByTestId("flow-particle")).toHaveLength(0);
  });

  it("上下文关闭粒子（减少动态效果 / 活跃边太多）时，有信号也不画粒子", () => {
    const { container } = renderEdge({ active: true, disabled: false }, { related: null, particles: false });
    expect(screen.queryAllByTestId("flow-particle")).toHaveLength(0);
    expect(basePath(container).style.strokeDasharray).toBe("");
  });

  it("悬停高亮：关联边加粗，其余边压暗且不画粒子", () => {
    const related = { nodes: new Set<string>(), edges: new Set(["e1"]) };
    const hit = renderEdge({ active: true, disabled: false }, { related, particles: true }, "e1");
    expect(basePath(hit.container).style.strokeWidth).toBe("2.5");
    expect(basePath(hit.container).style.opacity).toBe("1");
    expect(screen.getAllByTestId("flow-particle")).toHaveLength(2);
    hit.unmount();

    const miss = renderEdge({ active: true, disabled: false }, { related, particles: true }, "e2");
    expect(basePath(miss.container).style.strokeWidth).toBe("1.5");
    expect(basePath(miss.container).style.opacity).toBe("0.15");
    expect(screen.queryAllByTestId("flow-particle")).toHaveLength(0);
  });
});
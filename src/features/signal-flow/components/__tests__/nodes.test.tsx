// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { NodeProps } from "@xyflow/react";

const flags = vi.hoisted(() => ({ sacnEnabled: false }));
vi.mock("@xyflow/react", async (orig) => ({
  ...(await orig<typeof import("@xyflow/react")>()),
  Handle: () => null,
}));
vi.mock("@/features/settings", () => ({
  useProtocolFlags: () => ({ sacnEnabled: flags.sacnEnabled }),
}));

import i18n from "@/shared/i18n";
import { FlowDisplayContext } from "../../lib/flowContext";
import type {
  DestinationNodeData,
  PlayerNodeData,
  SourceNodeData,
  UniverseNodeData,
} from "../../lib/graphModel";
import { DestinationNode, PlayerNode, SourceNode, UniverseNode } from "../nodes";

const props = (id: string, data: unknown) => ({ id, data }) as unknown as NodeProps;

const source = (over: Partial<SourceNodeData> = {}): SourceNodeData => ({
  ip: "10.0.0.1",
  universeCount: 3,
  packetRate: 120,
  protocol: "artNet",
  active: true,
  ...over,
});
const universe = (over: Partial<UniverseNodeData> = {}): UniverseNodeData => ({
  universe: 5,
  sourceCount: 2,
  packetRate: 44,
  activeChannels: 300,
  conflictChannels: 0,
  conflict: "none",
  protocol: "artNet",
  active: true,
  ...over,
});
const dest = (over: Partial<DestinationNodeData> = {}): DestinationNodeData => ({
  name: "舞台左",
  ip: "10.0.0.5",
  port: 6454,
  protocol: "artNet",
  mode: "all",
  enabled: true,
  universeOffset: 0,
  delayMs: 0,
  sentRate: 44,
  active: true,
  ...over,
});

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  flags.sacnEnabled = false;
});
afterEach(() => cleanup());

describe("SourceNode", () => {
  it("显示 IP、Universe 数与包速率；sACN 关闭时省略协议", () => {
    render(<SourceNode {...props("src:10.0.0.1", source())} />);
    expect(screen.getByText("10.0.0.1")).toBeTruthy();
    expect(screen.getByText("3 uni · 120 pps")).toBeTruthy();
  });

  it("sACN 开启时在前面带上协议名", () => {
    flags.sacnEnabled = true;
    render(<SourceNode {...props("a", source({ protocol: "mixed" }))} />);
    expect(screen.getByText("Art-Net + sACN · 3 uni · 120 pps")).toBeTruthy();
  });

  it("有信号时有读屏提示，没有信号时没有", () => {
    const { unmount } = render(<SourceNode {...props("a", source())} />);
    expect(screen.getByText("有信号")).toBeTruthy();
    unmount();
    render(<SourceNode {...props("a", source({ active: false }))} />);
    expect(screen.queryByText("有信号")).toBeNull();
  });
});

describe("PlayerNode", () => {
  it("显示节目名，没有名字时用“回放”", () => {
    const data: PlayerNodeData = { name: "开场秀", universeCount: 2, active: false };
    const { unmount } = render(<PlayerNode {...props("p", data)} />);
    expect(screen.getByText("开场秀")).toBeTruthy();
    expect(screen.getByText("2 uni")).toBeTruthy();
    unmount();
    render(<PlayerNode {...props("p", { ...data, name: "" })} />);
    expect(screen.getByText("回放")).toBeTruthy();
  });
});

describe("UniverseNode", () => {
  it("显示编号、速率、来源数与活跃通道", () => {
    render(<UniverseNode {...props("uni:5", universe())} />);
    expect(screen.getByText("Universe 5")).toBeTruthy();
    expect(screen.getByText("44 pps · 2 src · 300 ch")).toBeTruthy();
  });

  it("有冲突时显示冲突徽标，级别随数据", () => {
    render(
      <UniverseNode
        {...props("uni:5", universe({ conflictChannels: 9, conflict: "warning" }))}
      />,
    );
    expect(screen.getByText(/9 个冲突通道/).className).toContain("bg-warning");
  });

  it("聚合态：总数、活跃数、总速率与进度条", () => {
    render(
      <UniverseNode
        {...props(
          "uni:agg",
          universe({ aggregate: true, totalUniverses: 60, activeUniverses: 12, packetRate: 480 }),
        )}
      />,
    );
    expect(screen.getByText("60 个 Universe")).toBeTruthy();
    expect(screen.getByText("12 个活跃 · 480 pps")).toBeTruthy();
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("12");
    expect(bar.getAttribute("aria-valuemax")).toBe("60");
    expect((bar.firstElementChild as HTMLElement).style.width).toBe("20%");
  });

  it("聚合态总数为 0 时进度为 0，不出现 NaN", () => {
    render(
      <UniverseNode
        {...props("uni:agg", universe({ aggregate: true, totalUniverses: 0, activeUniverses: 0 }))}
      />,
    );
    expect((screen.getByRole("progressbar").firstElementChild as HTMLElement).style.width).toBe("0%");
  });
});

describe("DestinationNode", () => {
  it("显示名称、地址:端口、模式", () => {
    render(<DestinationNode {...props("dst:a", dest())} />);
    expect(screen.getByText("舞台左")).toBeTruthy();
    expect(screen.getByText("10.0.0.5:6454")).toBeTruthy();
    expect(screen.getByText("全部 Universe")).toBeTruthy();
    expect(screen.queryByText("OFF")).toBeNull();
  });

  it("偏移带正负号，仅选定模式文案正确", () => {
    render(
      <DestinationNode {...props("dst:a", dest({ mode: "selected", universeOffset: 100 }))} />,
    );
    expect(screen.getByText("仅选定 · 偏移 +100")).toBeTruthy();
  });

  it("负偏移原样显示负号", () => {
    render(<DestinationNode {...props("dst:a", dest({ universeOffset: -20 }))} />);
    expect(screen.getByText("全部 Universe · 偏移 -20")).toBeTruthy();
  });

  it("停用：显示 OFF 标签", () => {
    render(<DestinationNode {...props("dst:a", dest({ enabled: false, active: false }))} />);
    expect(screen.getByText("OFF")).toBeTruthy();
  });

  it("有延迟时显示延迟标签", () => {
    render(<DestinationNode {...props("dst:a", dest({ delayMs: 30 }))} />);
    expect(screen.getByText("30ms")).toBeTruthy();
  });

  it("sACN 开启时地址前带协议", () => {
    flags.sacnEnabled = true;
    render(<DestinationNode {...props("dst:a", dest({ protocol: "sacn", port: 5568 }))} />);
    expect(screen.getByText("sACN → 10.0.0.5:5568")).toBeTruthy();
  });
});

describe("悬停高亮时的压暗", () => {
  const related = { nodes: new Set(["src:a"]), edges: new Set<string>() };
  const shell = (container: HTMLElement) => container.firstElementChild as HTMLElement;

  it("没有悬停时所有节点正常显示", () => {
    const { container } = render(<SourceNode {...props("src:a", source())} />);
    expect(shell(container).className).not.toContain("opacity-25");
  });

  it("悬停后，不在关联路径上的节点被压暗，关联节点保持", () => {
    const wrap = (id: string) => (
      <FlowDisplayContext.Provider value={{ related, particles: false }}>
        <SourceNode {...props(id, source())} />
      </FlowDisplayContext.Provider>
    );
    const inside = render(wrap("src:a"));
    expect(shell(inside.container).className).not.toContain("opacity-25");
    inside.unmount();
    const outside = render(wrap("src:other"));
    expect(shell(outside.container).className).toContain("opacity-25");
  });
});
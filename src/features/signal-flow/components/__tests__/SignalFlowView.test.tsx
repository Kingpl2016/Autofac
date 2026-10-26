// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { ForwardDestination } from "@/features/forwarding/lib/types";

/** 测试里的 ReactFlow 桩收到的属性（只列用到的）。 */
interface FlowNodeLike {
  id: string;
  type?: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}
interface RfProps {
  nodes: FlowNodeLike[];
  edgeTypes?: Record<string, unknown>;
  nodesConnectable?: boolean;
  deleteKeyCode?: unknown;
  colorMode?: string;
  children?: unknown;
  onNodeDragStop: (e: unknown, n: { id: string; position: { x: number; y: number } }) => void;
  onNodeMouseEnter: (e: unknown, n: { id: string }) => void;
  onNodeMouseLeave: () => void;
  onEdgeMouseEnter: (e: unknown, ed: { id: string }) => void;
  onEdgeMouseLeave: () => void;
}

const rf = vi.hoisted(() => ({
  props: null as null | RfProps,
  fitView: vi.fn(),
}));
const settings = vi.hoisted(() => ({ sacn: false, mode: "htp" as "htp" | "ltp" | "priority" }));
const fwd = vi.hoisted(() => ({
  data: { destinations: [] as ForwardDestination[] } as { destinations: ForwardDestination[] } | undefined,
}));
const player = vi.hoisted(() => ({
  status: {
    loaded: false,
    state: "stopped",
    name: "",
    universes: [] as number[],
    target: { kind: "forwarding" } as unknown,
  },
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    get = async () => undefined;
    set = async () => undefined;
    delete = async () => undefined;
  },
}));
vi.mock("@xyflow/react", async (orig) => {
  const actual = await orig<typeof import("@xyflow/react")>();
  const React = await import("react");
  const { FlowDisplayContext } = await import("../../lib/flowContext");
  /** 把上下文里的高亮与粒子开关写进 DOM，便于断言。 */
  function Probe() {
    const ctx = React.useContext(FlowDisplayContext);
    return React.createElement("output", {
      "data-testid": "ctx",
      "data-particles": String(ctx.particles),
      "data-related-nodes": ctx.related ? [...ctx.related.nodes].sort().join(",") : "none",
    });
  }
  return {
    ...actual,
    ReactFlow: (props: RfProps) => {
      rf.props = props;
      return React.createElement("div", { "data-testid": "rf" }, React.createElement(Probe), props.children as never);
    },
    ReactFlowProvider: ({ children }: { children: unknown }) => React.createElement(React.Fragment, null, children as never),
    useReactFlow: () => ({ fitView: rf.fitView }),
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
    Handle: () => null,
  };
});
vi.mock("@/features/settings", () => ({
  useProtocolFlags: () => ({ sacnEnabled: settings.sacn }),
  useSettingsQuery: () => ({ data: { merge: { mode: settings.mode } } }),
}));
vi.mock("@/features/forwarding/hooks/useForwarding", () => ({
  useForwardingQuery: () => fwd,
}));
vi.mock("@/features/recording", () => ({
  usePlayerStore: (sel: (s: { status: unknown }) => unknown) => sel({ status: player.status }),
}));

import i18n from "@/shared/i18n";
import type { UniverseSnapshot } from "@/shared/domain/engine";
import { useEngineDataStore } from "@/shared/stores/engineDataStore";
import { useOutputStore } from "@/shared/stores/outputStore";
import { newDestination } from "@/features/forwarding/lib/types";
import { DEFAULT_SIGNAL_FLOW_PREFS, useSignalFlowPrefs } from "../../stores/useSignalFlowPrefs";
import { SignalFlowView } from "../SignalFlowView";

const uni = (universe: number, over: Partial<UniverseSnapshot> = {}): UniverseSnapshot => ({
  universe,
  protocol: "artNet",
  sourceIps: ["10.0.0.1"],
  sourceCount: 1,
  activeChannels: 100,
  conflictChannels: 0,
  totalPackets: 0,
  packetRate: 44,
  sources: [{ ip: "10.0.0.1", packets: 0, packetRate: 44 }],
  ...over,
});
const dest = (id: string) => ({ ...newDestination(), id, name: id, targetIp: "10.0.1.1" });

const nodesProp = () => rf.props?.nodes ?? [];
const ctx = () => screen.getByTestId("ctx");

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  rf.props = null;
  rf.fitView.mockClear();
  settings.sacn = false;
  settings.mode = "htp";
  fwd.data = { destinations: [dest("a")] };
  player.status = { loaded: false, state: "stopped", name: "", universes: [], target: { kind: "forwarding" } };
  useSignalFlowPrefs.setState({ ...DEFAULT_SIGNAL_FLOW_PREFS });
  useEngineDataStore.setState({ universes: [uni(1), uni(2)] });
  useOutputStore.setState({ output: null, receivedAt: null });
  window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});
afterEach(() => cleanup());

describe("SignalFlowView 画布", () => {
  it("没有信号也没有目的地时显示空状态，不渲染画布", () => {
    useEngineDataStore.setState({ universes: [] });
    fwd.data = { destinations: [] };
    render(<SignalFlowView />);
    expect(screen.getByText("暂无信号或转发目的地")).toBeTruthy();
    expect(screen.queryByTestId("rf")).toBeNull();
  });

  it("按来源、Universe、目的地生成节点，只读：不可连线、Delete 不删节点", () => {
    render(<SignalFlowView />);
    const ids = nodesProp().map((n) => n.id).sort();
    expect(ids).toEqual(["dst:a", "src:10.0.0.1", "uni:1", "uni:2"]);
    expect(rf.props?.nodesConnectable).toBe(false);
    expect(rf.props?.deleteKeyCode).toBeNull();
    expect(Object.keys(rf.props?.edgeTypes ?? {})).toContain("flow");
  });

  it("画布区域有可访问名称", () => {
    render(<SignalFlowView />);
    expect(screen.getByRole("region", { name: "信号流图" })).toBeTruthy();
  });

  it("主题跟随应用，而不是写死暗色", async () => {
    const { usePrefsStore } = await import("@/shared/stores/prefsStore");
    usePrefsStore.setState({ theme: "light" });
    render(<SignalFlowView />);
    expect(rf.props?.colorMode).toBe("light");
    usePrefsStore.setState({ theme: "dark" });
  });

  it("渲染图例", () => {
    render(<SignalFlowView />);
    const legend = screen.getByRole("list", { name: "图例" });
    expect(legend.textContent).toContain("回放源");
    expect(legend.textContent).toContain("目的地");
    expect(legend.textContent).toContain("无信号或已停用");
  });
});

describe("SignalFlowView 简化阈值", () => {
  it("达到阈值时聚合并显示“简化模式”徽标", () => {
    useSignalFlowPrefs.setState({ simplifyThreshold: 2 });
    render(<SignalFlowView />);
    expect(screen.getByText("简化模式")).toBeTruthy();
    expect(nodesProp().some((n) => n.id === "uni:agg")).toBe(true);
  });

  it("阈值输入框写入偏好（用于持久化），超范围会被规整", () => {
    render(<SignalFlowView />);
    const input = screen.getByLabelText("简化阈值 (≥N)") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "2" } });
    expect(useSignalFlowPrefs.getState().simplifyThreshold).toBe(2);
    expect(screen.getByText("简化模式")).toBeTruthy();

    fireEvent.change(input, { target: { value: "0" } });
    expect(useSignalFlowPrefs.getState().simplifyThreshold).toBe(1);
  });

  it("输入过程中可以清空，不会被立刻改成 1；失焦后显示实际值", () => {
    useSignalFlowPrefs.setState({ simplifyThreshold: 30 });
    render(<SignalFlowView />);
    const input = screen.getByLabelText("简化阈值 (≥N)") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    expect(input.value).toBe("");
    expect(useSignalFlowPrefs.getState().simplifyThreshold).toBe(30);
    fireEvent.blur(input);
    expect(input.value).toBe("30");
  });

  it("读取已保存的阈值", () => {
    useSignalFlowPrefs.setState({ simplifyThreshold: 77 });
    render(<SignalFlowView />);
    expect((screen.getByLabelText("简化阈值 (≥N)") as HTMLInputElement).value).toBe("77");
  });
});

describe("SignalFlowView 悬停与动效", () => {
  it("悬停节点后上下文里出现关联路径，移开后清除", () => {
    render(<SignalFlowView />);
    expect(ctx().getAttribute("data-related-nodes")).toBe("none");

    act(() => rf.props?.onNodeMouseEnter({}, { id: "uni:1" }));
    expect(ctx().getAttribute("data-related-nodes")).toBe("dst:a,src:10.0.0.1,uni:1");

    act(() => rf.props?.onNodeMouseLeave());
    expect(ctx().getAttribute("data-related-nodes")).toBe("none");
  });

  it("悬停边同样生效", () => {
    render(<SignalFlowView />);
    act(() => rf.props?.onEdgeMouseEnter({}, { id: "uni:2->dst:a" }));
    expect(ctx().getAttribute("data-related-nodes")).toBe("dst:a,src:10.0.0.1,uni:2");
  });

  it("默认画粒子；开启“减少动态效果”后关闭", () => {
    const { unmount } = render(<SignalFlowView />);
    expect(ctx().getAttribute("data-particles")).toBe("true");
    unmount();

    window.matchMedia = ((q: string) => ({
      matches: q.includes("prefers-reduced-motion"),
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    render(<SignalFlowView />);
    expect(ctx().getAttribute("data-particles")).toBe("false");
  });

  it("有信号的边太多时自动降级为不画粒子", () => {
    useSignalFlowPrefs.setState({ simplifyThreshold: 9999 });
    useEngineDataStore.setState({
      universes: Array.from({ length: 90 }, (_, i) => uni(i + 1)),
    });
    render(<SignalFlowView />);
    expect(ctx().getAttribute("data-particles")).toBe("false");
  });
});

describe("SignalFlowView 布局", () => {
  const pos = (id: string) => nodesProp().find((n) => n.id === id)?.position;

  it("拖拽过的节点在数据刷新后保持位置，未拖拽的节点跟随排版", () => {
    render(<SignalFlowView />);
    const auto = pos("uni:1");
    act(() => rf.props?.onNodeDragStop({}, { id: "uni:1", position: { x: 500, y: 500 } }));
    expect(pos("uni:1")).toEqual({ x: 500, y: 500 });

    // 新增一个 Universe，触发重新构图
    act(() => useEngineDataStore.setState({ universes: [uni(1), uni(2), uni(3)] }));
    expect(pos("uni:1")).toEqual({ x: 500, y: 500 });
    expect(pos("uni:3")).toBeTruthy();
    expect(pos("uni:2")).not.toEqual({ x: 500, y: 500 });
    expect(auto).not.toEqual({ x: 500, y: 500 });
  });

  it("“重置布局”清除拖拽位置并适配视图", async () => {
    render(<SignalFlowView />);
    const auto = pos("uni:1");
    act(() => rf.props?.onNodeDragStop({}, { id: "uni:1", position: { x: 500, y: 500 } }));
    expect(pos("uni:1")).toEqual({ x: 500, y: 500 });

    vi.useFakeTimers({ toFake: ["requestAnimationFrame"] });
    fireEvent.click(screen.getByRole("button", { name: "重置布局" }));
    expect(pos("uni:1")).toEqual(auto);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    vi.useRealTimers();
    expect(rf.fitView).toHaveBeenCalledTimes(1);
  });

  it("画布为空时“重置布局”不可用", () => {
    useEngineDataStore.setState({ universes: [] });
    fwd.data = { destinations: [] };
    render(<SignalFlowView />);
    expect((screen.getByRole("button", { name: "重置布局" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("SignalFlowView 数据来源", () => {
  it("目的地节点带输出统计里的发送速率", () => {
    useOutputStore.setState({
      output: {
        state: "sending", sent: 0, sendErrors: 0, dropped: 0, sentRate: 0,
        lastError: null, lastErrorAgoMs: null, sender: "ready",
        destinations: [{ id: "a", sent: 1, errors: 0, dropped: 0, sentRate: 88, lastSendAgoMs: 0 }],
      },
      receivedAt: Date.now(),
    });
    render(<SignalFlowView />);
    const node = nodesProp().find((n) => n.id === "dst:a");
    expect(node?.data).toMatchObject({ sentRate: 88, active: true });
  });

  it("合并模式影响 Universe 节点的冲突级别", () => {
    settings.mode = "ltp";
    useEngineDataStore.setState({ universes: [uni(1, { conflictChannels: 4, sourceCount: 2 })] });
    render(<SignalFlowView />);
    const node = nodesProp().find((n) => n.id === "uni:1");
    expect(node?.data.conflict).toBe("warning");
  });

  it("sACN 关闭时过滤掉 sACN 目的地", () => {
    fwd.data = { destinations: [dest("a"), { ...dest("s"), protocol: "sacn" as const }] };
    render(<SignalFlowView />);
    const ids = nodesProp().map((n) => n.id);
    expect(ids).toContain("dst:a");
    expect(ids).not.toContain("dst:s");
  });

  it("回放中：展示回放源，播放状态决定是否有信号", () => {
    player.status = {
      loaded: true, state: "playing", name: "开场秀", universes: [5],
      target: { kind: "forwarding" },
    };
    render(<SignalFlowView />);
    const player1 = nodesProp().find((n) => n.type === "player");
    expect(player1?.data).toMatchObject({ name: "开场秀", active: true });
  });
});
describe("SignalFlowView 图 / 列表切换", () => {
  it("默认是节点图；切到列表后不再渲染画布，改为渲染表格", () => {
    render(<SignalFlowView />);
    expect(screen.getByTestId("rf")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "列表" }));
    expect(screen.queryByTestId("rf")).toBeNull();
    expect(screen.getAllByRole("table")).toHaveLength(2);
    expect(useSignalFlowPrefs.getState().view).toBe("list");
  });

  it("列表视图不做聚合：阈值再低也逐行列出全部 Universe，且没有简化徽标与图例", () => {
    useSignalFlowPrefs.setState({ simplifyThreshold: 2, view: "list" });
    useEngineDataStore.setState({ universes: [uni(1), uni(2), uni(3)] });
    render(<SignalFlowView />);
    const rows = screen.getAllByRole("table")[0].querySelectorAll("tbody tr");
    expect(rows).toHaveLength(3);
    expect(screen.queryByText("简化模式")).toBeNull();
    expect(screen.queryByRole("list", { name: "图例" })).toBeNull();
    expect(screen.queryByLabelText("简化阈值 (≥N)")).toBeNull();
  });

  it("读取已保存的视图偏好", () => {
    useSignalFlowPrefs.setState({ view: "list" });
    render(<SignalFlowView />);
    expect(screen.getAllByRole("table").length).toBeGreaterThan(0);
    expect((screen.getByRole("radio", { name: "列表" }) as HTMLButtonElement).getAttribute("aria-checked")).toBe("true");
  });

  it("节点图区域带有指向列表视图的读屏提示", () => {
    render(<SignalFlowView />);
    const region = screen.getByRole("region", { name: "信号流图" });
    const id = region.getAttribute("aria-describedby") as string;
    expect(document.getElementById(id)?.textContent).toContain("切换到“列表”视图");
  });

  it("列表视图里没有数据时仍显示空状态", () => {
    useSignalFlowPrefs.setState({ view: "list" });
    useEngineDataStore.setState({ universes: [] });
    fwd.data = { destinations: [] };
    render(<SignalFlowView />);
    expect(screen.getByText("暂无信号或转发目的地")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("列表视图里来源失去信号时，向读屏播报一次", async () => {
    const { useAnnouncerStore } = await import("@/shared/stores/announcerStore");
    useAnnouncerStore.setState({ message: "", seq: 0 });
    useSignalFlowPrefs.setState({ view: "list" });
    render(<SignalFlowView />);
    expect(useAnnouncerStore.getState().seq).toBe(0);

    act(() =>
      useEngineDataStore.setState({
        universes: [uni(1, { packetRate: 0, sources: [{ ip: "10.0.0.1", packets: 0, packetRate: 0 }] }), uni(2, { packetRate: 0, sources: [{ ip: "10.0.0.1", packets: 0, packetRate: 0 }] })],
      }),
    );
    expect(useAnnouncerStore.getState().message).toContain("信号中断：来源 10.0.0.1");
    const after = useAnnouncerStore.getState().seq;

    // 速率继续刷新但状态没变，不再播报
    act(() => useEngineDataStore.setState({ universes: [uni(1, { packetRate: 0, sources: [{ ip: "10.0.0.1", packets: 0, packetRate: 0 }] }), uni(2, { packetRate: 0, sources: [{ ip: "10.0.0.1", packets: 0, packetRate: 0 }] })] }));
    expect(useAnnouncerStore.getState().seq).toBe(after);
  });
});
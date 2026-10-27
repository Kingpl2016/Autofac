// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import i18n from "@/shared/i18n";
import type { ShowState } from "../../lib/playbackApi";

const invoke = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const bus = vi.hoisted(() => ({
  handler: null as null | ((s: unknown) => void),
  unlisten: vi.fn(),
  fail: false,
}));
vi.mock("@/shared/tauri/invoke", () => ({ invoke }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/shared/tauri/events", () => ({
  onEvent: (_event: string, handler: (s: unknown) => void) => {
    bus.handler = handler;
    return bus.fail ? Promise.reject(new Error("no tauri")) : Promise.resolve(bus.unlisten);
  },
}));

import { loadTestEngine } from "../../engine/__tests__/testEngine";
import { useEditorHotkeys } from "../../hooks/useEditorHotkeys";
import { useShowPlayback } from "../../hooks/useShowPlayback";
import { addStaticCue } from "../../lib/cueOps";
import { addFixtures } from "../../lib/ops";
import { createEmptyProject } from "../../lib/project";
import { RGBW } from "../../lib/__tests__/testkit";
import { useEditorUiStore } from "../../stores/useEditorUiStore";
import { usePlaybackStore } from "../../stores/usePlaybackStore";
import { useProjectStore } from "../../stores/useProjectStore";
import { FixtureRow } from "../FixtureRow";
import { PreviewPanel } from "../PreviewPanel";
import { TransportBar } from "../TransportBar";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // 预览色由 WASM 引擎求值
  loadTestEngine();
});

/** 后端状态的样板。 */
function state(over: Partial<ShowState> = {}): ShowState {
  return {
    loaded: true,
    transport: "stopped",
    positionMs: 0,
    durationMs: 180_000,
    looping: false,
    locate: null,
    universes: [0],
    warnings: [],
    outputting: false,
    destinations: null,
    dropped: 0,
    ...over,
  };
}

/** 模拟后端：按命令名返回状态。 */
function installBackend(initial: ShowState = state()) {
  let current = initial;
  invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "show_load":
      case "show_status":
        return current;
      case "show_play":
        current = { ...current, transport: "playing", outputting: true };
        return current;
      case "show_pause":
        current = { ...current, transport: "paused" };
        return current;
      case "show_stop":
        current = { ...current, transport: "stopped", outputting: false, positionMs: 0 };
        return current;
      case "show_seek":
        current = { ...current, positionMs: Number(args?.positionMs ?? 0) };
        return current;
      case "show_locate":
        current = { ...current, locate: (args?.fixtureId as string | null) ?? null, outputting: args?.fixtureId != null };
        return current;
      default:
        return null;
    }
  });
}

const calls = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd);
const project = () => useProjectStore.getState().project;

function Harness() {
  useShowPlayback();
  useEditorHotkeys();
  return (
    <>
      <TransportBar />
      <PreviewPanel />
    </>
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  invoke.mockReset();
  toast.error.mockReset();
  bus.handler = null;
  bus.fail = false;
  bus.unlisten.mockReset();
  useProjectStore.getState().load(createEmptyProject("t"));
  useEditorUiStore.setState({ playheadMs: 0, selectedCueIds: [], centerView: "swatches" });
  usePlaybackStore.getState().reset();
});

afterEach(() => cleanup());

const settle = () => act(async () => void (await Promise.resolve()));

describe("TransportBar 与后端播放引擎", () => {
  it("播放 / 暂停 / 停止：按钮发命令，状态来自后端回报", async () => {
    installBackend();
    render(<Harness />);
    await settle();
    const stop = screen.getByRole("button", { name: "停止" });
    expect((stop as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "播放" }));
    await waitFor(() => expect(calls("show_play")).toHaveLength(1));
    expect(await screen.findByRole("button", { name: "暂停" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "停止" }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    await waitFor(() => expect(calls("show_pause")).toHaveLength(1));
    fireEvent.click(await screen.findByRole("button", { name: "播放" }));
    await waitFor(() => expect(calls("show_play")).toHaveLength(2));
    fireEvent.click(await screen.findByRole("button", { name: "停止" }));
    await waitFor(() => expect(calls("show_stop").length).toBeGreaterThanOrEqual(1));
  });

  it("播放前先把最新工程送达后端", async () => {
    installBackend();
    render(<Harness />);
    await settle();
    invoke.mockClear();
    act(() => useProjectStore.getState().update((d) => void (d.name = "新名字")));
    fireEvent.click(screen.getByRole("button", { name: "播放" }));
    await waitFor(() => expect(calls("show_play")).toHaveLength(1));
    const order = invoke.mock.calls.map((c) => c[0]);
    expect(order.indexOf("show_load")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("show_load")).toBeLessThan(order.indexOf("show_play"));
    expect((calls("show_load")[0][1] as { project: { name: string } }).project.name).toBe("新名字");
  });

  it("启动时把工程交给后端，并把后端位置对齐到播放头", async () => {
    installBackend();
    act(() => useEditorUiStore.getState().setPlayhead(4000));
    render(<Harness />);
    await waitFor(() => expect(calls("show_seek").length).toBeGreaterThanOrEqual(1));
    expect(calls("show_load")).toHaveLength(1);
    expect(calls("show_seek")[0][1]).toEqual({ positionMs: 4000 });
  });

  it("后端推送的位置驱动播放头，且不会反过来再发跳转", async () => {
    installBackend();
    render(<Harness />);
    await settle();
    await waitFor(() => expect(bus.handler).not.toBeNull());
    invoke.mockClear();
    act(() => bus.handler?.(state({ transport: "playing", outputting: true, positionMs: 1234 })));
    expect(useEditorUiStore.getState().playheadMs).toBe(1234);
    expect(usePlaybackStore.getState().state?.transport).toBe("playing");
    await new Promise((r) => setTimeout(r, 80));
    expect(calls("show_seek")).toHaveLength(0);
  });

  it("用户移动播放头会发跳转命令", async () => {
    installBackend();
    render(<Harness />);
    await settle();
    await waitFor(() => expect(bus.handler).not.toBeNull());
    invoke.mockClear();
    act(() => useEditorUiStore.getState().setPlayhead(7000));
    await waitFor(() => expect(calls("show_seek")).toHaveLength(1));
    expect(calls("show_seek")[0][1]).toEqual({ positionMs: 7000 });
  });

  it("循环按钮改的是工程的输出设置（可撤销、会随工程保存）", async () => {
    installBackend();
    render(<Harness />);
    await settle();
    const loop = screen.getByRole("button", { name: "循环播放" });
    expect(loop.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(loop);
    expect(project().output.loop).toBe(true);
    expect(screen.getByRole("button", { name: "循环播放" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("后端拒绝播放时用 toast 说明原因", async () => {
    installBackend();
    render(<Harness />);
    await settle();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "show_play") throw "recording_active";
      return state();
    });
    fireEvent.click(screen.getByRole("button", { name: "播放" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(String(toast.error.mock.calls[0][0])).toContain("录制进行中");
  });

  it("空格播放 / 暂停；焦点在按钮或输入框上时不抢键", async () => {
    installBackend();
    render(<Harness />);
    await settle();
    invoke.mockClear();
    fireEvent.keyDown(window, { key: " " });
    await waitFor(() => expect(calls("show_play")).toHaveLength(1));
    // 焦点在按钮上：空格留给按钮自己
    const loop = screen.getByRole("button", { name: "循环播放" });
    loop.focus();
    fireEvent.keyDown(loop, { key: " " });
    await settle();
    expect(calls("show_pause")).toHaveLength(0);
  });

  it("卸载时停止输出并取消订阅", async () => {
    installBackend();
    const view = render(<Harness />);
    await settle();
    await waitFor(() => expect(bus.handler).not.toBeNull());
    invoke.mockClear();
    view.unmount();
    expect(calls("show_stop")).toHaveLength(1);
    await waitFor(() => expect(bus.unlisten).toHaveBeenCalled());
  });

  it("订阅事件失败不影响编辑器", async () => {
    installBackend();
    bus.fail = true;
    render(<Harness />);
    await settle();
    // 状态未知，但按钮仍可操作
    fireEvent.click(screen.getByRole("button", { name: "播放" }));
    await waitFor(() => expect(calls("show_play")).toHaveLength(1));
  });
});

describe("预览色块", () => {
  function withCue() {
    act(() =>
      useProjectStore.getState().update((d) => {
        const [f] = addFixtures(d, RGBW, 1);
        d.tracks.push({ id: "t1", target: { kind: "fixture", id: f }, mute: false, solo: false, lock: false });
        addStaticCue(d, "t1", 1000, { rgb: [255, 0, 0], lengthMs: 2000, brightness: 100, fadeInMs: 0, fadeOutMs: 0 });
        d.output.gamma = 1;
      }),
    );
  }

  it("没有灯具时提示添加", () => {
    render(<PreviewPanel />);
    expect(screen.getByText(/添加灯具后/)).toBeTruthy();
  });

  it("按播放头显示灯具颜色：Cue 区间内是红色，区间外是黑色", () => {
    withCue();
    render(<PreviewPanel />);
    const swatches = () => within(screen.getByRole("list")).getAllByRole("button");
    expect(swatches()[0].getAttribute("aria-label")).toContain("红 0");
    act(() => useEditorUiStore.getState().setPlayhead(2000));
    expect(swatches()[0].getAttribute("aria-label")).toContain("红 255");
    expect(swatches()[0].style.backgroundColor).toBe("rgb(255, 0, 0)");
  });
});

describe("灯具定位按钮", () => {
  function row() {
    let fixture!: ReturnType<typeof project>["fixtures"][number];
    act(() =>
      useProjectStore.getState().update((d) => {
        addFixtures(d, RGBW, 1);
        fixture = d.fixtures[0];
      }),
    );
    return (
      <ul>
        <FixtureRow
          fixture={project().fixtures[0] ?? fixture}
          modelName="RGBW"
          status={undefined}
          selected={false}
          onSelectedChange={() => undefined}
          onRename={() => undefined}
          onAddress={() => undefined}
          onDelete={() => undefined}
        />
      </ul>
    );
  }

  it("点击开始定位，再次点击结束；按下状态跟随后端", async () => {
    installBackend();
    render(row());
    const name = project().fixtures[0].name;
    fireEvent.click(screen.getByRole("button", { name: `定位 ${name}（只点亮这台灯具）` }));
    await waitFor(() => expect(calls("show_locate")).toHaveLength(1));
    expect(calls("show_locate")[0][1]).toEqual({ fixtureId: project().fixtures[0].id });
    const pressed = await screen.findByRole("button", { name: `定位 ${name}（只点亮这台灯具）`, pressed: true });
    fireEvent.click(pressed);
    await waitFor(() => expect(calls("show_locate")).toHaveLength(2));
    expect(calls("show_locate")[1][1]).toEqual({ fixtureId: null });
  });
});

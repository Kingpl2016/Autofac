// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

import i18n from "@/shared/i18n";
import type { ShowState } from "../../lib/playbackApi";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { createEmptyProject, type MediaClip, type MediaRef } from "../../lib/project";
import { useEditorUiStore } from "../../stores/useEditorUiStore";
import { useMediaStore } from "../../stores/useMediaStore";
import { usePlaybackStore } from "../../stores/usePlaybackStore";
import { useProjectStore } from "../../stores/useProjectStore";
import { MediaPlayers } from "../MediaPlayers";

/** jsdom 没有实现媒体播放：用可观察的替身代替。 */
const playMock = vi.fn();
const pauseMock = vi.fn();

beforeAll(() => {
  const state = new WeakMap<object, { paused: boolean; currentTime: number; playbackRate: number }>();
  const get = (el: object) => {
    let s = state.get(el);
    if (!s) {
      s = { paused: true, currentTime: 0, playbackRate: 1 };
      state.set(el, s);
    }
    return s;
  };
  Object.defineProperties(HTMLMediaElement.prototype, {
    paused: { configurable: true, get() { return get(this).paused; } },
    currentTime: {
      configurable: true,
      get() { return get(this).currentTime; },
      set(v: number) { get(this).currentTime = v; },
    },
    playbackRate: {
      configurable: true,
      get() { return get(this).playbackRate; },
      set(v: number) { get(this).playbackRate = v; },
    },
    play: {
      configurable: true,
      value() {
        playMock(this);
        get(this).paused = false;
        return Promise.resolve();
      },
    },
    pause: {
      configurable: true,
      value() {
        pauseMock(this);
        get(this).paused = true;
      },
    },
  });
});

/** 测试用素材：`offsetMs` 为它在自己轨道上那个片段的起点（整段素材）。 */
type Item = MediaRef & { offsetMs: number };

const media = (over: Partial<Item> = {}): Item => ({
  id: "a",
  kind: "audio",
  path: "a.mp3",
  name: "a.mp3",
  durationMs: 60_000,
  offsetMs: 0,
  ...over,
});

/** 每个素材一条轨道、一个整段片段（片段 id = `c-<素材 id>`）。 */
function projectOf(items: Item[], clips?: MediaClip[]) {
  const p = createEmptyProject("t");
  p.media = items.map(({ offsetMs: _o, ...m }) => m);
  p.mediaTracks = items.map((m) => ({ id: `t-${m.id}`, kind: m.kind, name: m.name, mute: false, solo: false, lock: false, volume: 1 }));
  p.mediaClips =
    clips ??
    items.map((m) => ({
      id: `c-${m.id}`,
      trackId: `t-${m.id}`,
      mediaId: m.id,
      startMs: m.offsetMs,
      inMs: 0,
      durationMs: m.durationMs,
      volume: 1,
      fadeInMs: 0,
      fadeOutMs: 0,
    }));
  return p;
}

function playback(over: Partial<ShowState> = {}): ShowState {
  return {
    loaded: true,
    transport: "stopped",
    positionMs: 0,
    durationMs: 180_000,
    looping: false,
    locate: null,
    universes: [],
    warnings: [],
    outputting: false,
    outputEnabled: true,
    sending: false,
    destinations: null,
    dropped: 0,
    ...over,
  };
}

function setup(
  items: Item[],
  runtime: Record<string, Partial<{ unplayable: boolean; status: "ready" | "missing" }>> = {},
  clips?: MediaClip[],
) {
  useProjectStore.getState().load(projectOf(items, clips));
  for (const m of items) {
    useMediaStore.getState().set(m.id, {
      path: m.path,
      status: "ready",
      url: `asset://localhost/${m.name}`,
      ...runtime[m.id],
    });
  }
  return render(<MediaPlayers />);
}

const element = (container: HTMLElement, tag: "audio" | "video", index = 0) =>
  container.querySelectorAll<HTMLMediaElement>(tag)[index];

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  playMock.mockClear();
  pauseMock.mockClear();
  toast.error.mockReset();
  useMediaStore.getState().reset();
  usePlaybackStore.getState().reset();
  useEditorUiStore.setState({ playheadMs: 0, mediaMuted: false });
});

afterEach(() => cleanup());

describe("MediaPlayers", () => {
  it("只为可播放的素材渲染元素：文件丢失 / 格式不支持的跳过", () => {
    const { container } = setup(
      [media(), media({ id: "b", path: "b.mp3", name: "b.mp3" }), media({ id: "c", path: "c.mkv", name: "c.mkv", kind: "video" })],
      { b: { unplayable: true }, c: { status: "missing" } },
    );
    expect(container.querySelectorAll("audio")).toHaveLength(1);
    expect(container.querySelectorAll("video")).toHaveLength(0);
    expect(element(container, "audio").getAttribute("src")).toBe("asset://localhost/a.mp3");
  });

  it("播放头处只显示最上面那条有片段的视频轨道；上面的轨道没有片段时露出下面的", () => {
    const { container } = setup([
      media({ id: "v1", kind: "video", path: "1.mp4", name: "1.mp4", durationMs: 10_000, offsetMs: 5000 }),
      media({ id: "v2", kind: "video", path: "2.mp4", name: "2.mp4" }),
    ]);
    const videos = () => [...container.querySelectorAll("video")];
    expect(videos()).toHaveLength(2);
    expect(videos()[0].className).toContain("hidden");
    expect(videos()[1].className).not.toContain("hidden");
    expect(screen.getByLabelText("2.mp4 的视频画面")).toBeTruthy();
    act(() => useEditorUiStore.getState().setPlayhead(6000));
    expect(videos()[0].className).not.toContain("hidden");
    expect(videos()[1].className).toContain("hidden");
    act(() => useEditorUiStore.getState().setPlayhead(30_000));
    expect(screen.getByLabelText("2.mp4 的视频画面")).toBeTruthy();
  });

  it("同一素材放两次 → 两个元素各自同步；入点裁剪后从入点开始放", () => {
    const clips: MediaClip[] = [
      { id: "x", trackId: "t-a", mediaId: "a", startMs: 0, inMs: 0, durationMs: 4000, volume: 1, fadeInMs: 0, fadeOutMs: 0 },
      { id: "y", trackId: "t-a", mediaId: "a", startMs: 10_000, inMs: 30_000, durationMs: 5000, volume: 1, fadeInMs: 0, fadeOutMs: 0 },
    ];
    const { container } = setup([media()], {}, clips);
    expect(container.querySelectorAll("audio")).toHaveLength(2);
    act(() => useEditorUiStore.getState().setPlayhead(12_000));
    const byClip = (id: string) => container.querySelector<HTMLMediaElement>(`[data-clip-id="${id}"]`)!;
    expect(byClip("y").currentTime).toBe(32); // 入点 30 s + 进入片段 2 s
    expect(byClip("x").currentTime).toBe(4); // 片段已结束，停在出点
    act(() => usePlaybackStore.getState().setState(playback({ transport: "playing", positionMs: 9_000 })));
    expect(playMock).not.toHaveBeenCalled();
    act(() => usePlaybackStore.getState().setState(playback({ transport: "playing", positionMs: 10_500 })));
    expect(playMock).toHaveBeenCalledTimes(1);
    expect(byClip("y").currentTime).toBe(30.5);
  });

  it("音量 = 片段音量 × 轨道音量 × 淡入淡出；轨道静音、独奏别的轨道时为 0", () => {
    const clips: MediaClip[] = [
      { id: "c-a", trackId: "t-a", mediaId: "a", startMs: 0, inMs: 0, durationMs: 10_000, volume: 0.5, fadeInMs: 2000, fadeOutMs: 0 },
      { id: "c-b", trackId: "t-b", mediaId: "b", startMs: 0, inMs: 0, durationMs: 10_000, volume: 1, fadeInMs: 0, fadeOutMs: 0 },
    ];
    const { container } = setup([media(), media({ id: "b", path: "b.mp3", name: "b.mp3" })], {}, clips);
    const el = (id: string) => container.querySelector<HTMLMediaElement>(`[data-clip-id="${id}"]`)!;
    act(() => useEditorUiStore.getState().setPlayhead(1000));
    expect(el("c-a").volume).toBeCloseTo(0.25); // 0.5 × 淡入一半
    act(() => useEditorUiStore.getState().setPlayhead(5000));
    expect(el("c-a").volume).toBeCloseTo(0.5);
    act(() => useProjectStore.getState().update((d) => void (d.mediaTracks[0].volume = 0.5)));
    act(() => useEditorUiStore.getState().setPlayhead(5100));
    expect(el("c-a").volume).toBeCloseTo(0.25);
    act(() => useProjectStore.getState().update((d) => void (d.mediaTracks[1].solo = true)));
    act(() => useEditorUiStore.getState().setPlayhead(5200));
    expect(el("c-a").volume).toBe(0);
    expect(el("c-b").volume).toBe(1);
    act(() => useProjectStore.getState().update((d) => void (d.mediaTracks[1].mute = true)));
    act(() => useEditorUiStore.getState().setPlayhead(5300));
    expect(el("c-b").volume).toBe(0);
  });

  it("后端开始播放：元素定位到目标位置并播放", () => {
    const { container } = setup([media({ offsetMs: 2_000 })]);
    act(() => usePlaybackStore.getState().setState(playback({ transport: "playing", positionMs: 5_000 })));
    const el = element(container, "audio");
    expect(el.currentTime).toBe(3); // 5000 - 2000 偏移
    expect(playMock).toHaveBeenCalledTimes(1);
  });

  it("播放中偏差大于 200 ms 直接跳转；小偏差变速追平", () => {
    const { container } = setup([media()]);
    act(() => usePlaybackStore.getState().setState(playback({ transport: "playing", positionMs: 10_000 })));
    const el = element(container, "audio");
    // 元素落后 1 秒 → 跳转
    el.currentTime = 9;
    act(() => usePlaybackStore.getState().setState(playback({ transport: "playing", positionMs: 10_000, dropped: 1 })));
    expect(el.currentTime).toBe(10);
    // 元素超前 100 ms → 放慢
    el.currentTime = 10.1;
    act(() => usePlaybackStore.getState().setState(playback({ transport: "playing", positionMs: 10_000, dropped: 2 })));
    expect(el.playbackRate).toBeCloseTo(0.95, 9);
    // 回到同步 → 恢复速率 1
    el.currentTime = 10;
    act(() => usePlaybackStore.getState().setState(playback({ transport: "playing", positionMs: 10_000, dropped: 3 })));
    expect(el.playbackRate).toBe(1);
  });

  it("暂停后元素暂停；停止后元素回到起点", () => {
    const { container } = setup([media()]);
    act(() => usePlaybackStore.getState().setState(playback({ transport: "playing", positionMs: 4_000 })));
    const el = element(container, "audio");
    expect(el.paused).toBe(false);
    act(() => usePlaybackStore.getState().setState(playback({ transport: "paused", positionMs: 4_500 })));
    expect(el.paused).toBe(true);
    act(() => useEditorUiStore.getState().setPlayhead(0));
    act(() => usePlaybackStore.getState().setState(playback({ transport: "stopped", positionMs: 0 })));
    expect(el.currentTime).toBe(0);
  });

  it("未播放时拖动播放头，元素跟着定位（视频显示对应画面）", () => {
    const { container } = setup([media({ id: "v", kind: "video", path: "v.mp4", name: "v.mp4" })]);
    act(() => useEditorUiStore.getState().setPlayhead(12_000));
    expect(element(container, "video").currentTime).toBe(12);
    act(() => useEditorUiStore.getState().setPlayhead(90_000));
    expect(element(container, "video").currentTime).toBe(60); // 夹取到素材末尾
  });

  it("时间线还没走到素材时不播放，到了才开始", () => {
    const { container } = setup([media({ offsetMs: 5_000 })]);
    act(() => usePlaybackStore.getState().setState(playback({ transport: "playing", positionMs: 1_000 })));
    expect(playMock).not.toHaveBeenCalled();
    act(() => usePlaybackStore.getState().setState(playback({ transport: "playing", positionMs: 6_000 })));
    expect(playMock).toHaveBeenCalledTimes(1);
    expect(element(container, "audio").currentTime).toBe(1);
  });

  it("静音开关作用于元素", () => {
    const { container } = setup([media()]);
    expect(element(container, "audio").muted).toBe(false);
    act(() => useEditorUiStore.getState().toggleMuted());
    expect(element(container, "audio").muted).toBe(true);
  });

  it("play() 被拒绝时提示一次，不影响灯光", async () => {
    const original = HTMLMediaElement.prototype.play;
    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      configurable: true,
      value: () => Promise.reject(new Error("NotAllowedError")),
    });
    setup([media()]);
    await act(async () => {
      usePlaybackStore.getState().setState(playback({ transport: "playing", positionMs: 1_000 }));
      await Promise.resolve();
    });
    await act(async () => {
      usePlaybackStore.getState().setState(playback({ transport: "playing", positionMs: 1_033 }));
      await Promise.resolve();
    });
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(String(toast.error.mock.calls[0][0])).toContain("无法播放 a.mp3");
    Object.defineProperty(HTMLMediaElement.prototype, "play", { configurable: true, value: original });
  });

  it("卸载时停掉还在响的元素", () => {
    const view = setup([media()]);
    act(() => usePlaybackStore.getState().setState(playback({ transport: "playing", positionMs: 1_000 })));
    pauseMock.mockClear();
    view.unmount();
    expect(pauseMock).toHaveBeenCalled();
  });
});

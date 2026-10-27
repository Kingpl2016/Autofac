// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

import i18n from "@/shared/i18n";
import type { ShowState } from "../../lib/playbackApi";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { createEmptyProject, type MediaRef } from "../../lib/project";
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

const media = (over: Partial<MediaRef> = {}): MediaRef => ({
  id: "a",
  kind: "audio",
  path: "a.mp3",
  name: "a.mp3",
  durationMs: 60_000,
  offsetMs: 0,
  ...over,
});

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
    destinations: null,
    dropped: 0,
    ...over,
  };
}

function setup(items: MediaRef[], runtime: Record<string, Partial<{ unplayable: boolean; status: "ready" | "missing" }>> = {}) {
  useProjectStore.getState().load({ ...createEmptyProject("t"), media: items });
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

  it("第一个视频可见，其余视频隐藏", () => {
    const { container } = setup([
      media({ id: "v1", kind: "video", path: "1.mp4", name: "1.mp4" }),
      media({ id: "v2", kind: "video", path: "2.mp4", name: "2.mp4" }),
    ]);
    const videos = container.querySelectorAll("video");
    expect(videos).toHaveLength(2);
    expect(videos[0].className).not.toContain("hidden");
    expect(videos[1].className).toContain("hidden");
    expect(screen.getByLabelText("1.mp4 的视频画面")).toBeTruthy();
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
    const { container } = setup([media({ kind: "video", path: "v.mp4", name: "v.mp4" })]);
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

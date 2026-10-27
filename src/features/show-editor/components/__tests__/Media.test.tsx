// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import i18n from "@/shared/i18n";
import type { MediaInfo, Peaks } from "../../lib/mediaApi";

const invoke = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
const pickers = vi.hoisted(() => ({ pickMediaFiles: vi.fn() }));
vi.mock("@/shared/tauri/invoke", () => ({ invoke }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/shared/tauri/pickers", () => pickers);
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => `asset://localhost/${encodeURIComponent(p)}` }));

import { useAnnouncerStore } from "@/shared/stores/announcerStore";
import { importMediaPaths } from "../../hooks/mediaActions";
import { useMediaRuntime } from "../../hooks/useMediaRuntime";
import { createEmptyProject } from "../../lib/project";
import { useMediaStore } from "../../stores/useMediaStore";
import { useProjectStore } from "../../stores/useProjectStore";
import { WaveformStrip } from "../../timeline/WaveformStrip";
import { MediaTab } from "../MediaTab";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

const project = () => useProjectStore.getState().project;
const calls = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd);

const PEAKS: Peaks = { perSecond: 50, durationMs: 1000, peaks: [-10, 10, -20, 20] };

/** 模拟后端：`files` 是"磁盘上存在"的文件及其探测结果。 */
function installBackend(files: Record<string, Partial<MediaInfo>>, opts: { peaksFail?: boolean } = {}) {
  invoke.mockImplementation(async (cmd: string, args?: { path?: string }) => {
    const path = args?.path ?? "";
    const info = files[path];
    if (cmd === "media_probe") {
      if (!info) throw "not_found";
      return { kind: "audio", durationMs: 60_000, hasAudio: true, sampleRate: 44100, channels: 2, ...info };
    }
    if (cmd === "media_authorize") {
      if (!info) throw "not_found";
      return undefined;
    }
    if (cmd === "media_peaks") {
      if (opts.peaksFail) throw "unsupported";
      return PEAKS;
    }
    return null;
  });
}

function Harness() {
  useMediaRuntime();
  return (
    <>
      <MediaTab />
      <WaveformStrip />
    </>
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  invoke.mockReset();
  pickers.pickMediaFiles.mockReset();
  for (const fn of Object.values(toast)) fn.mockReset();
  useProjectStore.getState().load(createEmptyProject("t"));
  useMediaStore.getState().reset();
  useAnnouncerStore.setState({ message: "", seq: 0 });
});

afterEach(() => cleanup());

describe("导入音视频", () => {
  it("选择文件后探测并加入工程；比节目长的素材会延长节目", async () => {
    installBackend({ "D:\\music\\歌.mp3": { durationMs: 300_000 } });
    pickers.pickMediaFiles.mockResolvedValue(["D:\\music\\歌.mp3"]);
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "导入音视频…" }));
    await waitFor(() => expect(project().media).toHaveLength(1));
    expect(project().media[0]).toMatchObject({
      kind: "audio",
      path: "D:\\music\\歌.mp3",
      name: "歌.mp3",
      durationMs: 300_000,
      offsetMs: 0,
    });
    expect(project().durationMs).toBe(300_000);
    expect(useAnnouncerStore.getState().message).toBe("已导入 1 个素材");
    // 取消选择不做任何事
    pickers.pickMediaFiles.mockResolvedValue([]);
    fireEvent.click(screen.getByRole("button", { name: "导入音视频…" }));
    await act(async () => void (await Promise.resolve()));
    expect(project().media).toHaveLength(1);
  });

  it("导入后自动放行并计算波形，显示波形图", async () => {
    installBackend({ "a.mp3": {} });
    render(<Harness />);
    await act(async () => void (await importMediaPaths(["a.mp3"])));
    await waitFor(() => expect(screen.getByRole("img", { name: "a.mp3 的波形" })).toBeTruthy());
    expect(calls("media_authorize")).toHaveLength(1);
    expect(calls("media_peaks")[0][1]).toEqual({ path: "a.mp3", perSecond: 50 });
    const id = project().media[0].id;
    expect(useMediaStore.getState().items[id]).toMatchObject({
      status: "ready",
      url: "asset://localhost/a.mp3",
    });
  });

  it("不支持的扩展名被跳过并提示；同一路径不会重复导入；单个失败不影响其他", async () => {
    installBackend({ "a.mp3": {}, "b.wav": {} });
    await importMediaPaths(["notes.txt", "a.mp3", "ghost.mp3", "b.wav"]);
    expect(toast.warning).toHaveBeenCalledWith("1 个文件不是支持的音视频格式，已跳过");
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(String(toast.error.mock.calls[0][0])).toContain("找不到文件：ghost.mp3");
    expect(project().media.map((m) => m.name)).toEqual(["a.mp3", "b.wav"]);
    expect(await importMediaPaths(["a.mp3"])).toBe(0);
    expect(project().media).toHaveLength(2);
  });

  it("视频无法从容器读出时长时，改从 <video> 元数据读取", async () => {
    installBackend({ "clip.mp4": { kind: "video", durationMs: null, hasAudio: false } });
    const created: HTMLMediaElement[] = [];
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string, opts?: ElementCreationOptions) => {
      const el = realCreate(tag, opts);
      if (tag === "video") {
        created.push(el as HTMLMediaElement);
        Object.defineProperty(el, "duration", { value: 12.5, configurable: true });
        Object.defineProperty(el, "load", { value: () => undefined, configurable: true });
        queueMicrotask(() => (el as HTMLMediaElement).onloadedmetadata?.(new Event("loadedmetadata")));
      }
      return el;
    });
    await importMediaPaths(["clip.mp4"]);
    expect(created).toHaveLength(1);
    expect(project().media[0]).toMatchObject({ kind: "video", durationMs: 12_500 });
    vi.restoreAllMocks();
  });

  it("没有音轨的视频仍可用，只是没有波形", async () => {
    installBackend({ "clip.mp4": { kind: "video", durationMs: 8000, hasAudio: false } }, { peaksFail: true });
    render(<Harness />);
    await act(async () => void (await importMediaPaths(["clip.mp4"])));
    const id = project().media[0].id;
    await waitFor(() => expect(useMediaStore.getState().items[id]?.status).toBe("ready"));
    expect(useMediaStore.getState().items[id].peaks).toBeUndefined();
    expect(screen.queryByRole("img", { name: /波形/ })).toBeNull();
    expect(screen.getByText("没有音轨，无波形")).toBeTruthy();
  });
});

describe("素材行", () => {
  async function withMedia(files: Record<string, Partial<MediaInfo>>, paths: string[]) {
    installBackend(files);
    render(<Harness />);
    await act(async () => void (await importMediaPaths(paths)));
  }

  it("改偏移、移除", async () => {
    await withMedia({ "a.mp3": {} }, ["a.mp3"]);
    const offset = screen.getByLabelText("a.mp3 的偏移（毫秒）") as HTMLInputElement;
    fireEvent.change(offset, { target: { value: "-250" } });
    fireEvent.blur(offset);
    expect(project().media[0].offsetMs).toBe(-250);
    fireEvent.click(screen.getByRole("button", { name: "移除 a.mp3（不会删除文件）" }));
    expect(project().media).toHaveLength(0);
    await waitFor(() => expect(Object.keys(useMediaStore.getState().items)).toHaveLength(0));
  });

  it("加载时找不到文件 → 显示“文件找不到了”，重新链接到新文件后恢复", async () => {
    // 工程里已经有素材，但磁盘上没有
    installBackend({ "new.wav": { durationMs: 30_000 } });
    act(() => {
      useProjectStore.getState().update((d) => {
        d.media.push({ id: "m1", kind: "audio", path: "old.mp3", name: "old.mp3", durationMs: 60_000, offsetMs: 500 });
      });
    });
    render(<Harness />);
    expect(await screen.findByText("文件找不到了")).toBeTruthy();
    pickers.pickMediaFiles.mockResolvedValue(["new.wav"]);
    fireEvent.click(screen.getByRole("button", { name: "重新链接…" }));
    await waitFor(() => expect(project().media[0].path).toBe("new.wav"));
    expect(project().media[0]).toMatchObject({ id: "m1", name: "new.wav", durationMs: 30_000, offsetMs: 500 });
    await waitFor(() => expect(useMediaStore.getState().items.m1?.status).toBe("ready"));
    expect(screen.queryByText("文件找不到了")).toBeNull();
  });
});

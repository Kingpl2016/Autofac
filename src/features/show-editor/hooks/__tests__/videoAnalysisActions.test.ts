import { produce } from "immer";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { testAnalysis } from "../../lib/__tests__/analysisKit";

const api = vi.hoisted(() => ({
  mediaAuthorize: vi.fn(async () => undefined),
  mediaCacheGet: vi.fn(async (): Promise<string | null> => null),
  mediaCachePut: vi.fn(async () => undefined),
}));
vi.mock("../../lib/mediaApi", async (orig) => ({ ...(await orig<typeof import("../../lib/mediaApi")>()), ...api }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => `asset://localhost/${p}`, invoke: vi.fn() }));
vi.mock("@/features/ai/lib/api", () => ({
  aiHistoryRead: async () => null,
  aiHistoryWrite: async () => undefined,
  aiHistoryLibraryPath: async (e: string) => e,
}));

import type { FrameImage } from "../../lib/pixelMap";
import { createEmptyProject, type MediaRef } from "../../lib/project";
import { videoCacheText } from "../../lib/videoAnalysis";
import { currentAnalysis, useMediaAnalysisStore } from "../../stores/useMediaAnalysisStore";
import { useMediaStore } from "../../stores/useMediaStore";
import { ensureVideoAnalysis } from "../videoAnalysisActions";

const video: MediaRef = { id: "v", kind: "video", path: "D:/clip.mp4", name: "clip.mp4", durationMs: 4000 };
const audio: MediaRef = { id: "a", kind: "audio", path: "D:/song.mp3", name: "song.mp3", durationMs: 64_000 };

/** 前 2 秒红、后 2 秒蓝。 */
const frame = (ms: number): FrameImage => {
  const data = new Uint8ClampedArray(16);
  for (let i = 0; i < 4; i += 1) data.set(ms < 2000 ? [230, 20, 20, 255] : [20, 20, 230, 255], i * 4);
  return { width: 2, height: 2, data };
};

beforeEach(() => {
  vi.clearAllMocks();
  useMediaAnalysisStore.setState({ entries: {}, videos: {} });
  useMediaStore.getState().reset();
});

describe("视频画面分析的界面动作", () => {
  it("没有缓存时取帧计算，结果写回缓存；再次调用不重复计算", async () => {
    const open = vi.fn(async (url: string) => {
      expect(url).toBe("asset://localhost/D:/clip.mp4");
      return { grab: async (ms: number) => frame(ms) };
    });
    expect(await ensureVideoAnalysis(video, open)).toBe(true);
    expect(api.mediaAuthorize).toHaveBeenCalledWith("D:/clip.mp4");
    const entry = useMediaAnalysisStore.getState().videos.v;
    expect(entry.status).toBe("ready");
    expect(entry.video?.cuts.map((c) => c.atMs)).toEqual([2000]);
    expect(api.mediaCachePut).toHaveBeenCalledWith("D:/clip.mp4", "video", expect.any(String));
    expect(await ensureVideoAnalysis(video, open)).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("命中缓存时不取帧；画面不可读时记成不支持", async () => {
    api.mediaCacheGet.mockResolvedValueOnce(videoCacheText({ cuts: [{ atMs: 1000, strength: 1 }], shots: [] }));
    const open = vi.fn();
    expect(await ensureVideoAnalysis(video, open)).toBe(true);
    expect(open).not.toHaveBeenCalled();

    useMediaAnalysisStore.setState({ videos: {} });
    const tainted = async () => ({ grab: async (): Promise<FrameImage> => Promise.reject(new DOMException("tainted", "SecurityError")) });
    expect(await ensureVideoAnalysis(video, tainted)).toBe(false);
    expect(useMediaAnalysisStore.getState().videos.v.status).toBe("unsupported");
  });

  it("音乐与视频是不同素材：切镜按视频片段的位置并进主素材的分析", () => {
    const project = produce(createEmptyProject("t"), (d) => {
      d.media.push(audio, video);
      d.mediaTracks.push({ id: "mt1", kind: "audio", name: "A", mute: false, solo: false, lock: false, volume: 1 });
      d.mediaTracks.push({ id: "mt2", kind: "video", name: "V", mute: false, solo: false, lock: false, volume: 1 });
      d.mediaClips.push({ id: "ca", trackId: "mt1", mediaId: "a", startMs: 0, inMs: 0, durationMs: 64_000 } as never);
      d.mediaClips.push({ id: "cv", trackId: "mt2", mediaId: "v", startMs: 10_000, inMs: 0, durationMs: 4000 } as never);
    });
    useMediaAnalysisStore.setState({
      entries: { a: { path: audio.path, status: "ready", audio: testAnalysis(), error: null, refreshing: false, sensitivity: 1, requestId: null } },
      videos: { v: { path: video.path, status: "ready", video: { cuts: [{ atMs: 2000, strength: 1 }], shots: [{ startMs: 0, endMs: 4000, rgb: [1, 2, 3], brightness: 0.5 }] } } },
    });
    const a = currentAnalysis(project)!;
    expect(a.bpm).toBe(120);
    expect(a.events.filter((e) => e.kind === "cut").map((e) => e.atMs)).toEqual([12_000]);
    expect(a.shots).toEqual([{ startMs: 10_000, endMs: 14_000, rgb: [1, 2, 3], brightness: 0.5 }]);
  });
});

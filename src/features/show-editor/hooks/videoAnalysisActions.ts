import { convertFileSrc } from "@tauri-apps/api/core";

import { mediaAuthorize, mediaCacheGet, mediaCachePut } from "../lib/mediaApi";
import type { MediaRef } from "../lib/project";
import { analyzeVideo, parseVideoCache, VIDEO_GRAB_WIDTH, videoCacheText } from "../lib/videoAnalysis";
import type { FrameSource } from "../lib/pixelMap";
import { useMediaAnalysisStore, videoMedia } from "../stores/useMediaAnalysisStore";
import { useMediaStore } from "../stores/useMediaStore";
import { useProjectStore } from "../stores/useProjectStore";
import { VideoFrameSource } from "./pixelMapActions";

/**
 * 视频画面分析的界面动作：先查后端缓存，没有时在 webview 里取帧计算（离屏 `<video>` + 画布，
 * 与像素映射同一套取帧），结果写回缓存与分析 store。同一素材同时只跑一次。
 */

/** 打开帧源（测试可替换）。 */
type Open = (url: string, width: number) => Promise<FrameSource & { dispose?: () => void }>;

/** 进行中的分析（素材 id）：同一素材同时只跑一次。 */
const running = new Set<string>();

/**
 * 分析一个视频素材（已有结果或正在分析时什么也不做）。
 *
 * @param media 视频素材。
 * @param open 打开帧源；省略时用离屏 `<video>`。
 * @returns 是否得到了结果。
 */
export async function ensureVideoAnalysis(media: MediaRef, open: Open = VideoFrameSource.open): Promise<boolean> {
  if (media.kind !== "video") return false;
  const store = useMediaAnalysisStore.getState();
  const cur = store.videos[media.id];
  if (cur?.path === media.path && (cur.status === "ready" || cur.status === "unsupported" || running.has(media.id))) return cur.status === "ready";
  if (running.has(media.id)) return false;
  running.add(media.id);
  store.setVideo(media.id, { path: media.path, status: "loading" });
  let source: Awaited<ReturnType<Open>> | null = null;
  try {
    const cached = parseVideoCache(await mediaCacheGet(media.path, "video").catch(() => null));
    if (cached) {
      useMediaAnalysisStore.getState().setVideo(media.id, { path: media.path, status: "ready", video: cached });
      return true;
    }
    const item = useMediaStore.getState().items[media.id];
    let url = item?.status === "ready" ? item.url : undefined;
    if (!url) {
      await mediaAuthorize(media.path);
      url = convertFileSrc(media.path);
    }
    source = await open(url, VIDEO_GRAB_WIDTH);
    const result = await analyzeVideo(source, media.durationMs);
    useMediaAnalysisStore.getState().setVideo(media.id, { path: media.path, status: "ready", video: result });
    void mediaCachePut(media.path, "video", videoCacheText(result)).catch(() => undefined);
    return true;
  } catch (e) {
    // 画面不可读（跨域污染的画布）：记成不支持，不再重试
    const unsupported = e instanceof DOMException && e.name === "SecurityError";
    useMediaAnalysisStore.getState().setVideo(media.id, { path: media.path, status: unsupported ? "unsupported" : "error" });
    return false;
  } finally {
    source?.dispose?.();
    running.delete(media.id);
  }
}

/**
 * 只读缓存：之前分析过的视频直接得到结果，否则记成 `none`（不在 webview 里取帧，避免影响操作）。
 *
 * @param media 视频素材。
 * @returns 是否有结果。
 */
export async function peekVideoAnalysis(media: MediaRef): Promise<boolean> {
  if (media.kind !== "video") return false;
  const cur = useMediaAnalysisStore.getState().videos[media.id];
  if (cur?.path === media.path) return cur.status === "ready";
  const cached = parseVideoCache(await mediaCacheGet(media.path, "video").catch(() => null));
  if (useMediaAnalysisStore.getState().videos[media.id]?.status === "loading") return false;
  useMediaAnalysisStore.getState().setVideo(media.id, cached ? { path: media.path, status: "ready", video: cached } : { path: media.path, status: "none" });
  return !!cached;
}

/** 关键帧的宽度（像素）。 */
const KEYFRAME_WIDTH = 320;

/**
 * 截取视频关键帧（JPEG，Base64，不带 `data:` 前缀），发给支持图片输入的模型标注用。
 *
 * @param media 视频素材。
 * @param timesMs 素材内时刻。
 * @param open 打开帧源；省略时用离屏 `<video>`。
 * @returns 与时刻一一对应的 Base64；取不到的为空串。
 */
export async function keyframesJpeg(media: MediaRef, timesMs: readonly number[], open: Open = VideoFrameSource.open): Promise<string[]> {
  const item = useMediaStore.getState().items[media.id];
  let url = item?.status === "ready" ? item.url : undefined;
  if (!url) {
    await mediaAuthorize(media.path);
    url = convertFileSrc(media.path);
  }
  const source = await open(url, KEYFRAME_WIDTH);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  try {
    const out: string[] = [];
    for (const at of timesMs) {
      try {
        const img = await source.grab(at);
        if (!ctx || !(img instanceof ImageData)) {
          out.push("");
          continue;
        }
        canvas.width = img.width;
        canvas.height = img.height;
        ctx.putImageData(img, 0, 0);
        out.push(canvas.toDataURL("image/jpeg", 0.7).replace(/^data:image\/jpeg;base64,/, ""));
      } catch {
        out.push("");
      }
    }
    return out;
  } finally {
    source.dispose?.();
  }
}

/**
 * 当前工程视频素材已有的画面分析（只读缓存，不取帧）。
 */
export async function peekProjectVideo(): Promise<void> {
  const media = videoMedia(useProjectStore.getState().project);
  if (media) await peekVideoAnalysis(media);
}

import i18n from "@/shared/i18n";
import {
  buildPixelEntries,
  insertPixelScene,
  mapPoints,
  samplePixelFrames,
  type BakeProgress,
  type FrameImage,
  type FrameSource,
  type PixelMapOptions,
} from "../lib/pixelMap";
import { useProjectStore } from "../stores/useProjectStore";

/** 取样画面的宽度（像素）：灯具取样只需要很低的分辨率。 */
const GRAB_WIDTH = 96;
/** 单帧定位的超时（毫秒）。 */
const SEEK_TIMEOUT_MS = 5000;

/**
 * 用一个离屏 `<video>` + 画布取帧的帧源。每次 `grab` 定位到指定时刻、等 `seeked` 后把画面缩小画到画布上读像素。
 */
export class VideoFrameSource implements FrameSource {
  readonly #video: HTMLVideoElement;
  readonly #canvas: HTMLCanvasElement;
  readonly #ctx: CanvasRenderingContext2D;

  private constructor(video: HTMLVideoElement, canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) {
    this.#video = video;
    this.#canvas = canvas;
    this.#ctx = ctx;
  }

  /**
   * 打开视频（等元数据加载完）。
   *
   * @param url 可播放的地址（asset 协议）。
   * @returns 帧源。
   * @throws 视频无法加载或画布不可用时抛出错误。
   */
  static async open(url: string): Promise<VideoFrameSource> {
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.playsInline = true;
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error("video_load_failed"));
      video.src = url;
    });
    const canvas = document.createElement("canvas");
    const aspect = video.videoWidth > 0 ? video.videoHeight / video.videoWidth : 9 / 16;
    canvas.width = GRAB_WIDTH;
    canvas.height = Math.max(1, Math.round(GRAB_WIDTH * aspect));
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("canvas_unavailable");
    return new VideoFrameSource(video, canvas, ctx);
  }

  async grab(sourceMs: number): Promise<FrameImage> {
    const v = this.#video;
    const target = Math.max(0, sourceMs / 1000);
    if (Math.abs(v.currentTime - target) > 0.001) {
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error("seek_timeout")), SEEK_TIMEOUT_MS);
        v.onseeked = () => {
          window.clearTimeout(timer);
          resolve();
        };
        v.currentTime = target;
      });
    }
    const { width, height } = this.#canvas;
    this.#ctx.drawImage(v, 0, 0, width, height);
    return this.#ctx.getImageData(0, 0, width, height);
  }

  /** 释放视频。 */
  dispose(): void {
    this.#video.removeAttribute("src");
    this.#video.load();
  }
}

/** 一次像素映射烘焙的参数。 */
export interface BakeRequest {
  /** 视频片段 */
  clipId: string;
  /** 参与的灯具 */
  fixtureIds: readonly string[];
  options: PixelMapOptions;
  /** 帧源 */
  source: FrameSource;
  onProgress?: BakeProgress;
  signal?: AbortSignal;
}

/**
 * 把一个视频片段烘焙成场景片段，放在与视频片段相同的时间范围（一步撤销）。
 *
 * @param request 参数。
 * @returns 新场景片段 id；片段不存在、没有灯具或放不下时为 `null`。
 * @throws 取帧失败，或被取消（`AbortError`）。
 */
export async function bakePixelMap(request: BakeRequest): Promise<string | null> {
  const project = useProjectStore.getState().project;
  const clip = project.mediaClips.find((c) => c.id === request.clipId);
  const fixtures = project.fixtures.filter((f) => request.fixtureIds.includes(f.id));
  if (!clip || fixtures.length === 0) return null;
  const points = mapPoints(fixtures, project.stage, request.options);
  const frames = await samplePixelFrames(
    request.source,
    { inMs: clip.inMs, durationMs: clip.durationMs },
    points,
    request.options.fps,
    request.onProgress,
    request.signal,
  );
  const entries = buildPixelEntries(frames, fixtures.map((f) => f.id), request.options);
  const name = project.media.find((m) => m.id === clip.mediaId)?.name ?? "";
  let id: string | null = null;
  useProjectStore.getState().update((d) => {
    id = insertPixelScene(
      d,
      entries,
      clip.startMs,
      clip.startMs + clip.durationMs,
      i18n.t("editor.pixelMap.trackName"),
      i18n.t("editor.pixelMap.clipLabel", { name }),
    );
  });
  return id;
}

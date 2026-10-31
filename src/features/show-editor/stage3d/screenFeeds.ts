import { activeClipOfMedia } from "../lib/mediaClips";
import type { Rgb, ShowProject } from "../lib/project";
import type { ScreenFeed } from "./ThreeStageRenderer";

/**
 * LED 屏这一帧的画面来源。
 *
 * - 视频素材：取时间线上此刻正在播放这个素材的片段，用 `MediaPlayers` 为它渲染的 `<video data-clip-id>` 元素
 *   （与时间线同步，不另开解码器）；此刻没有片段时黑屏。
 * - 像素灯：按型号的矩阵排布（列 × 行，行优先、从 1 编号）取每个像素的预览色（键为 `灯具id#n`）；
 *   没有分像素的灯整块显示整灯颜色。
 *
 * @param project 工程（只读）。
 * @param colors 这一帧的预览颜色。
 * @param atMs 播放头时刻。
 * @param findVideo 片段 id → 视频元素（测试里可替换）。
 * @returns 有内容的屏幕的画面。
 */
export function screenFeeds(
  project: Pick<ShowProject, "stage" | "mediaClips" | "fixtures" | "fixtureModels">,
  colors: ReadonlyMap<string, Rgb>,
  atMs: number,
  findVideo: (clipId: string) => HTMLVideoElement | null = videoOfClip,
): ScreenFeed[] {
  const out: ScreenFeed[] = [];
  for (const o of project.stage.objects) {
    if (o.kind !== "screen" || !o.content) continue;
    if (o.content.kind === "media") {
      const clip = activeClipOfMedia(project, o.content.mediaId, atMs);
      const video = clip ? findVideo(clip) : null;
      if (video) out.push({ objectId: o.id, video });
      continue;
    }
    const fixtureId = o.content.fixtureId;
    const f = project.fixtures.find((x) => x.id === fixtureId);
    if (!f) continue;
    const matrix = project.fixtureModels.find((m) => m.id === f.modelId)?.matrix;
    const cols = Math.max(1, matrix?.cols ?? 1);
    const rows = Math.max(1, matrix?.rows ?? 1);
    out.push({ objectId: o.id, pixels: { cols, rows, data: pixelData(fixtureId, cols, rows, colors) } });
  }
  return out;
}

/**
 * 像素灯的画面（RGBA，纹理的第一行在底部，所以从最后一行写起）。
 *
 * @param fixtureId 灯具 id。
 * @param cols 列数。
 * @param rows 行数。
 * @param colors 预览颜色。
 * @returns `cols × rows × 4` 字节。
 */
export function pixelData(fixtureId: string, cols: number, rows: number, colors: ReadonlyMap<string, Rgb>): Uint8Array {
  const data = new Uint8Array(cols * rows * 4);
  const whole = colors.get(fixtureId) ?? [0, 0, 0];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const c = colors.get(`${fixtureId}#${y * cols + x + 1}`) ?? whole;
      const i = ((rows - 1 - y) * cols + x) * 4;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = 255;
    }
  }
  return data;
}

/** `MediaPlayers` 渲染的视频元素。 */
function videoOfClip(clipId: string): HTMLVideoElement | null {
  return document.querySelector<HTMLVideoElement>(`video[data-clip-id="${CSS.escape(clipId)}"]`);
}

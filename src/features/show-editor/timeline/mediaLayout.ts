import type { MediaTrack } from "../lib/project";

/** 媒体轨道各高度档位的行高（像素）。 */
export const MEDIA_TRACK_HEIGHTS: Record<NonNullable<MediaTrack["height"]>, number> = {
  compact: 28,
  normal: 48,
  tall: 80,
};

/**
 * 媒体轨道的行高。
 *
 * @param track 轨道。
 * @returns 像素。
 */
export function mediaTrackHeight(track: Pick<MediaTrack, "height">): number {
  return MEDIA_TRACK_HEIGHTS[track.height ?? "normal"];
}

/** 媒体轨道区的纵向布局。 */
export interface MediaLayout {
  tops: number[];
  heights: number[];
  total: number;
}

/**
 * 计算媒体轨道区的布局（从上到下）。
 *
 * @param tracks 媒体轨道。
 * @returns 每行的顶部、高度与总高。
 */
export function mediaLayout(tracks: readonly Pick<MediaTrack, "height">[]): MediaLayout {
  const tops: number[] = [];
  const heights: number[] = [];
  let y = 0;
  for (const t of tracks) {
    const h = mediaTrackHeight(t);
    tops.push(y);
    heights.push(h);
    y += h;
  }
  return { tops, heights, total: y };
}

/**
 * 纵坐标落在哪一行。
 *
 * @param layout 布局。
 * @param y 相对媒体轨道区顶部的纵坐标。
 * @returns 行号；在所有行之外时为 -1。
 */
export function mediaRowAt(layout: MediaLayout, y: number): number {
  if (y < 0 || y >= layout.total) return -1;
  for (let i = 0; i < layout.tops.length; i += 1) {
    if (y < layout.tops[i] + layout.heights[i]) return i;
  }
  return -1;
}

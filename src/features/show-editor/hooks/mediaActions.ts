import { convertFileSrc } from "@tauri-apps/api/core";
import { toast } from "sonner";
import type { TFunction } from "i18next";

import i18n from "@/shared/i18n";
import { announce } from "@/shared/stores/announcerStore";
import { newId } from "../lib/ids";
import { extensionOf, fileNameOf, isMediaPath, mediaEndMs } from "../lib/media";
import { canPlayExtension } from "../lib/mediaSync";
import {
  MEDIA_ERR,
  mediaAuthorize,
  mediaPeaks,
  mediaProbe,
  PEAKS_PER_SECOND,
  type MediaInfo,
} from "../lib/mediaApi";
import { addMedia, ensureDuration, relinkMedia } from "../lib/ops";
import type { MediaRef } from "../lib/project";
import { useMediaStore } from "../stores/useMediaStore";
import { useProjectStore } from "../stores/useProjectStore";

/** 从 `<audio>` / `<video>` 元数据读取时长的超时。 */
const METADATA_TIMEOUT_MS = 8000;

/**
 * 把后端的素材错误码转成用户能看懂的文案。
 *
 * @param t 翻译函数。
 * @param error 后端 reject 的值。
 * @param name 素材文件名。
 */
export function mediaErrorText(t: TFunction, error: unknown, name: string): string {
  const raw = typeof error === "string" ? error : error instanceof Error ? error.message : String(error);
  switch (raw) {
    case MEDIA_ERR.notFound:
      return t("editor.media.errors.notFound", { name });
    case MEDIA_ERR.unsupportedExtension:
    case MEDIA_ERR.unsupported:
      return t("editor.media.errors.unsupported", { name });
    case MEDIA_ERR.decode:
      return t("editor.media.errors.decode", { name });
    default:
      return t("editor.media.errors.generic", { name, reason: raw });
  }
}

/**
 * 用 webview 读取素材元数据里的时长（后端读不出时长的视频使用）。
 *
 * @param url 可播放的地址。
 * @param kind 素材类型。
 * @returns 时长（毫秒）；读取失败或超时为 `null`。
 */
export function readDurationViaElement(url: string, kind: MediaRef["kind"]): Promise<number | null> {
  return new Promise((resolve) => {
    const el = document.createElement(kind);
    let settled = false;
    const done = (value: number | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      el.removeAttribute("src");
      el.load();
      resolve(value);
    };
    const timer = window.setTimeout(() => done(null), METADATA_TIMEOUT_MS);
    el.preload = "metadata";
    el.onloadedmetadata = () =>
      done(Number.isFinite(el.duration) && el.duration > 0 ? Math.round(el.duration * 1000) : null);
    el.onerror = () => done(null);
    el.src = url;
  });
}

/**
 * 加载一个素材的运行时状态：放行 asset 协议、取播放地址、计算波形。
 *
 * 重复调用是安全的；工程里该素材的路径在加载期间变了（重新链接），旧结果会被丢弃。
 *
 * @param media 素材引用。
 */
export async function loadMedia(media: MediaRef): Promise<void> {
  const store = useMediaStore.getState();
  store.set(media.id, { path: media.path, status: "loading" });
  const stillCurrent = () => useMediaStore.getState().items[media.id]?.path === media.path;
  try {
    await mediaAuthorize(media.path);
  } catch (e) {
    if (!stillCurrent()) return;
    const missing = e === MEDIA_ERR.notFound;
    useMediaStore.getState().set(media.id, {
      path: media.path,
      status: missing ? "missing" : "error",
      error: String(e),
    });
    return;
  }
  const url = convertFileSrc(media.path);
  let peaks;
  try {
    peaks = await mediaPeaks(media.path, PEAKS_PER_SECOND);
  } catch {
    // 无音轨（静音视频）或解码失败：没有波形，但素材仍可播放
    peaks = undefined;
  }
  if (!stillCurrent()) return;
  const unplayable = !canPlayExtension(extensionOf(media.path));
  useMediaStore.getState().set(media.id, { path: media.path, status: "ready", url, peaks, unplayable });
}

/**
 * 探测一个文件并生成素材引用。
 *
 * @param path 文件路径。
 * @returns 素材引用（偏移 0）。
 * @throws 后端错误码字符串（文件不存在、格式不支持等）。
 */
export async function describeMedia(path: string): Promise<MediaRef> {
  const info: MediaInfo = await mediaProbe(path);
  let durationMs = info.durationMs;
  if (durationMs === null) {
    await mediaAuthorize(path);
    durationMs = await readDurationViaElement(convertFileSrc(path), info.kind);
  }
  if (durationMs === null || durationMs <= 0) throw MEDIA_ERR.unsupported;
  return {
    id: newId(),
    kind: info.kind,
    path,
    name: fileNameOf(path),
    durationMs,
    offsetMs: 0,
  };
}

/**
 * 导入一批文件：不支持的扩展名与已引用的路径被跳过，其余探测后加入工程；
 * 比节目更长的素材会自动延长节目时长。每个失败的文件单独报告，不影响其他文件。
 *
 * @param paths 本地文件路径（文件对话框或系统拖放）。
 * @returns 实际加入的素材数量。
 */
export async function importMediaPaths(paths: readonly string[]): Promise<number> {
  const t = i18n.t.bind(i18n) as TFunction;
  const usable = paths.filter(isMediaPath);
  const skipped = paths.length - usable.length;
  if (skipped > 0) toast.warning(t("editor.media.skipped", { count: skipped }));
  let added = 0;
  for (const path of usable) {
    if (useProjectStore.getState().project.media.some((m) => m.path === path)) continue;
    try {
      const media = await describeMedia(path);
      let id: string | null = null;
      let extended = false;
      useProjectStore.getState().update((d) => {
        id = addMedia(d, media);
        if (id) extended = ensureDuration(d, mediaEndMs(media));
      });
      if (id) {
        added += 1;
        if (extended) announce(t("editor.media.extended", { name: media.name }));
      }
    } catch (e) {
      toast.error(mediaErrorText(t, e, fileNameOf(path)));
    }
  }
  if (added > 0) announce(t("editor.media.added", { count: added }));
  return added;
}

/**
 * 重新链接一个素材到新文件（保留偏移）。
 *
 * @param id 素材 id。
 * @param path 新文件路径。
 * @returns 是否成功。
 */
export async function relinkMediaTo(id: string, path: string): Promise<boolean> {
  const t = i18n.t.bind(i18n) as TFunction;
  try {
    const next = await describeMedia(path);
    let ok = false;
    useProjectStore.getState().update((d) => {
      ok = relinkMedia(d, id, { path: next.path, name: next.name, kind: next.kind, durationMs: next.durationMs });
    });
    if (!ok) toast.error(t("editor.media.errors.duplicate"));
    return ok;
  } catch (e) {
    toast.error(mediaErrorText(t, e, fileNameOf(path)));
    return false;
  }
}

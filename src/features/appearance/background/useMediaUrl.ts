/** @file 把 IndexedDB 里的背景媒体变成可用的对象 URL，并在不再使用时释放 */
import { useEffect, useState } from "react";

import { loadMedia, type MediaKind } from "./mediaStore";

/** 媒体加载状态 */
export type MediaUrlState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "missing" };

/**
 * 读取背景媒体并生成对象 URL。
 *
 * @remarks
 * - `version` 变化（换了文件）时重新读取
 * - 对象 URL 会在卸载或变化时 revoke，不泄漏内存
 * - 文件不存在（如设置是从别的浏览器导入的，只有元数据）时状态为 `missing`，由调用方回退
 *
 * @param kind - 媒体类型；为 null 时不读取
 * @param version - 媒体版本号
 * @returns 加载状态
 *
 * @example
 * ```tsx
 * const media = useMediaUrl('image', background.media?.version ?? 0)
 * if (media.status === 'ready') return <img src={media.url} alt="" />
 * ```
 */
export function useMediaUrl(kind: MediaKind | null, version: number): MediaUrlState {
  const key = `${kind ?? ""}:${version}`;
  // 记下“哪一个 key 的结果”：key 变化后、新结果到达之前，派生为 loading，而不是在 effect 里同步 setState
  const [result, setResult] = useState<{ key: string; state: MediaUrlState } | null>(null);
  useEffect(() => {
    if (!kind) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    void loadMedia(kind).then((blob) => {
      if (cancelled) return;
      if (!blob) {
        setResult({ key, state: { status: "missing" } });
        return;
      }
      objectUrl = URL.createObjectURL(blob);
      setResult({ key, state: { status: "ready", url: objectUrl } });
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [kind, version, key]);
  if (!kind) return { status: "idle" };
  return result?.key === key ? result.state : { status: "loading" };
}
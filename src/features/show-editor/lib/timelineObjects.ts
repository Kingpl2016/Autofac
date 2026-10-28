import { removeKeyAt } from "./keyframes";
import { fixed } from "./looks";
import { removeMarker } from "./ops";
import type { Look, Param, ShowProject } from "./project";
import { removeSection } from "./sections";
import type { TimelineObject } from "../stores/useEditorUiStore";

/**
 * 时间线上的“标记类”对象（标记点、段落、A-B 循环区间、片段里的关键帧）的删除操作。
 * 编辑操作在 immer 草稿上执行（一次调用 = 一步撤销）。
 */

/**
 * 删除一个标记点或段落。
 *
 * @param d 工程草稿。
 * @param obj 对象。
 * @returns 被删对象的名字；对象已不存在时为 `null`。
 */
export function deleteTimelineObject(d: ShowProject, obj: TimelineObject): string | null {
  if (obj.kind === "marker") {
    const m = d.markers.find((x) => x.id === obj.id);
    if (!m) return null;
    removeMarker(d, obj.id);
    return m.label;
  }
  const s = d.sections.find((x) => x.id === obj.id);
  if (!s) return null;
  removeSection(d, obj.id);
  return s.name;
}

/** 对外观里每个参数层执行同一个变换。 */
function mapLook(look: Look, f: <T>(p: Param<T>) => Param<T>): void {
  if (look.intensity) look.intensity = f(look.intensity);
  if (look.color) look.color = f(look.color);
  for (const key of Object.keys(look.attrs ?? {}) as (keyof NonNullable<Look["attrs"]>)[]) {
    const p = look.attrs?.[key];
    if (p && look.attrs) look.attrs[key] = f(p);
  }
}

/** 片段里所有外观（外观片段的外观，场景片段每台灯的外观）。 */
function looksOf(d: ShowProject, cueId: string): Look[] {
  const cue = d.cues.find((c) => c.id === cueId);
  if (!cue || d.tracks.find((t) => t.id === cue.trackId)?.lock) return [];
  if (cue.kind === "look") return [cue.look];
  if (cue.kind === "scene") return cue.entries.map((e) => e.look);
  return [];
}

/**
 * 删除片段里 `uMs` 处的关键帧（所有层在这一时刻的关键帧一起删）。
 *
 * @param d 工程草稿。
 * @param cueId 片段（锁定轨道上的不动）。
 * @param uMs 片段内时刻。
 * @returns 删掉的关键帧数。
 */
export function removeLookKeysAt(d: ShowProject, cueId: string, uMs: number): number {
  let n = 0;
  for (const look of looksOf(d, cueId)) {
    mapLook(look, (p) => {
      const next = removeKeyAt(p, uMs);
      if (next !== p) n += 1;
      return next;
    });
  }
  return n;
}

/**
 * 删除片段里的全部关键帧：每个关键帧层改成固定值（取第一帧的值）。
 *
 * @param d 工程草稿。
 * @param cueId 片段（锁定轨道上的不动）。
 * @returns 改成固定值的层数。
 */
export function clearLookKeys(d: ShowProject, cueId: string): number {
  let n = 0;
  for (const look of looksOf(d, cueId)) {
    mapLook(look, (p) => {
      if (p.kind !== "keys" || p.keys.length === 0) return p;
      n += 1;
      return fixed(p.keys[0].value) as typeof p;
    });
  }
  return n;
}

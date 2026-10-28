import i18n from "@/shared/i18n";
import { announce } from "@/shared/stores/announcerStore";
import { setLoopRange, setTempo } from "../lib/ops";
import { clearLookKeys, deleteTimelineObject, removeLookKeysAt } from "../lib/timelineObjects";
import { useEditorUiStore, type TimelineObject } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";
import { notifyDeleted } from "./deleteFeedback";

/**
 * 时间线标记类对象的删除动作（快捷键、右键菜单、悬停 × 共用）：一次动作一步撤销，删除后弹出可撤销的提示。
 */

const t = (key: string, args?: Record<string, unknown>) => i18n.t(key, args);
const update = (recipe: Parameters<ReturnType<typeof useProjectStore.getState>["update"]>[0]) =>
  useProjectStore.getState().update(recipe);

/**
 * 删除一个标记点 / 段落，并取消它的选中。
 *
 * @param obj 对象。
 * @returns 是否删除（对象已不存在时为 `false`）。
 */
export function deleteObject(obj: TimelineObject): boolean {
  let name: string | null = null;
  update((d) => {
    name = deleteTimelineObject(d, obj);
  });
  const ui = useEditorUiStore.getState();
  if (ui.selectedTimelineObject?.id === obj.id) ui.selectTimelineObject(null);
  if (name === null) return false;
  notifyDeleted(t(obj.kind === "marker" ? "editor.markers.deleted" : "editor.sections.deleted", { name }));
  return true;
}

/**
 * 删除当前选中的标记点 / 段落（Delete 键）。
 *
 * @returns 是否有选中的对象并删除了它。
 */
export function deleteSelectedObject(): boolean {
  const obj = useEditorUiStore.getState().selectedTimelineObject;
  return obj ? deleteObject(obj) : false;
}

/** 清除 A-B 循环区间。 */
export function clearLoop(): void {
  if (!useProjectStore.getState().project.loopRange) return;
  update((d) => setLoopRange(d, null));
  notifyDeleted(t("editor.loop.cleared"));
}

/** 清除节拍网格（BPM）。 */
export function clearTempo(): void {
  if (!useProjectStore.getState().project.tempo) return;
  update((d) => setTempo(d, null));
  notifyDeleted(t("editor.tempo.cleared"));
}

/**
 * 删除片段在某一时刻的关键帧。
 *
 * @param cueId 片段。
 * @param uMs 片段内时刻。
 */
export function deleteKeyAt(cueId: string, uMs: number): void {
  let n = 0;
  update((d) => {
    n = removeLookKeysAt(d, cueId, uMs);
  });
  if (n > 0) notifyDeleted(t("editor.keys.deleted", { count: n }));
  else announce(t("editor.keys.none"));
}

/**
 * 删除片段里的全部关键帧（各层改成固定值）。
 *
 * @param cueId 片段。
 */
export function clearKeys(cueId: string): void {
  let n = 0;
  update((d) => {
    n = clearLookKeys(d, cueId);
  });
  if (n > 0) notifyDeleted(t("editor.keys.cleared", { count: n }));
  else announce(t("editor.keys.none"));
}

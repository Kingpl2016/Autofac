import type { KeyboardEvent } from "react";

import { OUTPUT_FPS } from "../lib/project";
import type { CueActions } from "./useCueActions";
import { isTextEntry } from "./useEditorHotkeys";

/**
 * 处理时间线面板上的键盘快捷键。
 *
 * - `Delete` / `Backspace`：删除选中的 Cue
 * - `Ctrl/⌘+C`：复制；`Ctrl/⌘+V`：粘贴到播放头；`Ctrl/⌘+D`：复制一份接在后面
 * - `←` / `→`：把选中的 Cue 平移 1 帧；按住 `Shift` 平移 10 帧
 * - `Esc`：取消选择
 *
 * 焦点在文本输入框里时不处理。
 *
 * @param e 键盘事件。
 * @param actions Cue 编辑动作。
 * @param clearSelection 取消选择的回调。
 * @returns 事件已被处理时为 `true`（已调用 `preventDefault`）。
 */
export function handleTimelineKey(
  e: KeyboardEvent,
  actions: CueActions,
  clearSelection: () => void,
): boolean {
  if (isTextEntry(e.target)) return false;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (!mod && (e.key === "Delete" || e.key === "Backspace")) {
    actions.removeSelected();
  } else if (!mod && e.key === "Escape") {
    clearSelection();
  } else if (mod && !e.shiftKey && !e.altKey && key === "c") {
    actions.copySelected();
  } else if (mod && !e.shiftKey && !e.altKey && key === "v") {
    actions.pasteAtPlayhead();
  } else if (mod && !e.shiftKey && !e.altKey && key === "d") {
    actions.duplicateSelected();
  } else if (!mod && !e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
    const frames = e.shiftKey ? 10 : 1;
    const direction = e.key === "ArrowLeft" ? -1 : 1;
    actions.nudgeSelected(direction * Math.round((frames * 1000) / OUTPUT_FPS));
  } else {
    return false;
  }
  e.preventDefault();
  return true;
}

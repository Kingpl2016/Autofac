import { useEffect, useRef } from "react";

import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";
import { addMarkerAtPlayhead, tapTempoNow } from "./editorActions";
import { togglePlay } from "./transportActions";

/**
 * 当前焦点是否在文本输入控件里（此时 Ctrl+Z 等应交给输入框自己的撤销）。
 *
 * @param target 键盘事件目标。
 * @returns 是输入框、文本域、下拉框或可编辑区域时为 `true`。
 */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

/**
 * 编辑器的全局快捷键（`onSave` 是保存动作，由文件操作提供）：
 *
 * - `Ctrl/⌘+Z` 撤销，`Ctrl/⌘+Shift+Z` 或 `Ctrl+Y` 重做；
 * - `Space` 播放 / 暂停，`M` 在播放头处打标记点，`T` 敲击节拍（Tap Tempo），`S` 开关吸附；
 * - `Ctrl/⌘+S` 保存（在输入框里也生效，保存前输入框会因失焦而提交）。
 *
 * 焦点在文本输入框里时不拦截，交给输入框自己的撤销。组件卸载时自动解除。
 */
export function useEditorHotkeys(onSave?: () => void): void {
  const saveRef = useRef(onSave);
  useEffect(() => {
    saveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.altKey) return;
      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && key === "s") {
        e.preventDefault();
        if (e.target instanceof HTMLElement && isTextEntry(e.target)) e.target.blur();
        saveRef.current?.();
        return;
      }
      if (isTextEntry(e.target)) return;
      if (!(e.ctrlKey || e.metaKey)) {
        // 对话框打开时，单字母快捷键不抢键
        if (e.shiftKey || e.repeat || document.querySelector("[role=dialog]")) return;
        if (key === " ") {
          // 焦点在按钮 / 链接 / 滑杆上时，空格留给它们自己的激活行为
          if (e.target instanceof HTMLElement && e.target.closest("button, a, [role=button], [role=slider], [role=menuitem]")) return;
          void togglePlay();
        } else if (key === "m") addMarkerAtPlayhead();
        else if (key === "t") tapTempoNow(performance.now());
        else if (key === "s") useEditorUiStore.getState().toggleSnap();
        else return;
        e.preventDefault();
        return;
      }
      const temporal = useProjectStore.temporal.getState();
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        temporal.undo();
      } else if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault();
        temporal.redo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

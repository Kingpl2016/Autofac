import { useEffect, useRef } from "react";

import { matchCommand, type Command } from "../lib/commands";
import { currentOverrides } from "../stores/useKeymapStore";
import { useEditorCommands } from "./useEditorCommands";

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

/** 按住不放时不重复触发的命令（切换类、一次性动作）。 */
const NO_REPEAT = new Set([
  "transport.toggle",
  "transport.stop",
  "timeline.split",
  "timeline.snap",
  "timeline.marker",
  "timeline.tap",
  "view.palette",
  "edit.duplicate",
  "edit.paste",
  "file.save",
]);

/**
 * 编辑器的全局快捷键：按命令表（见 `useEditorCommands`，默认方案与剪映一致）分发键盘事件，
 * 用户可在快捷键设置里改键。
 *
 * - 焦点在文本输入框里时只响应全局命令（保存、命令面板）；保存前输入框失焦以提交草稿；
 * - 有对话框打开时只响应全局命令；
 * - 焦点在按钮 / 滑杆等控件上时，空格留给它们自己的激活行为；
 * - 已被其它处理器处理（`defaultPrevented`）的事件不再处理。
 *
 * @param onSave 保存动作（来自文件操作）。
 * @returns 命令列表（供命令面板使用）。
 */
export function useEditorHotkeys(onSave?: () => void): Command[] {
  const commands = useEditorCommands(onSave);
  const ref = useRef(commands);
  useEffect(() => {
    ref.current = commands;
  }, [commands]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const inText = isTextEntry(e.target);
      const dialogOpen = document.querySelector("[role=dialog]") !== null;
      const command = matchCommand(ref.current, currentOverrides(), e, inText || dialogOpen);
      if (!command) return;
      if (e.repeat && NO_REPEAT.has(command.id)) {
        e.preventDefault();
        return;
      }
      if (
        command.id === "transport.toggle" &&
        e.target instanceof HTMLElement &&
        e.target.closest("button, a, [role=button], [role=slider], [role=menuitem], [role=option]")
      ) {
        return;
      }
      e.preventDefault();
      if (command.id === "file.save" && e.target instanceof HTMLElement && inText) e.target.blur();
      command.run();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return commands;
}

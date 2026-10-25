/**
 * 焦点所在的元素是否自己处理键盘输入（输入框、按钮、单选、滑块、下拉、对话框……）。
 *
 * 这些元素上按空格 / 方向键有它们自己的含义，全局快捷键不应该抢。
 *
 * # Arguments
 *
 * * `target` - 键盘事件的 `target`。
 *
 * # Returns
 *
 * 目标是（或位于）会自行处理按键的元素内时为 `true`。
 */
export function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.closest(
      'input, textarea, select, button, summary, a[href], [role="slider"], [role="switch"], [role="radio"], [role="tab"], [role="combobox"], [role="dialog"]',
    ) !== null
  );
}

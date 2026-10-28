import type { PanelImperativeHandle } from "react-resizable-panels";

import { useEditorUiStore } from "../stores/useEditorUiStore";

/** 可以收起的编辑器侧栏。 */
export type CollapsiblePanel = "library" | "inspector";

/** 布局挂载时登记的面板句柄（编辑器同一时间只挂载一个）。 */
const handles: Partial<Record<CollapsiblePanel, PanelImperativeHandle | null>> = {};

/**
 * 登记 / 注销面板句柄（`ShowEditorView` 挂载时调用）。
 *
 * @param panel 面板。
 * @param handle 句柄；`null` 注销。
 */
export function registerPanel(panel: CollapsiblePanel, handle: PanelImperativeHandle | null): void {
  handles[panel] = handle;
}

/**
 * 面板当前是否收起（读 store：布局完成后由面板尺寸回写，与界面显示一致）。
 *
 * @param panel 面板。
 * @returns 是否收起。
 */
export function isPanelCollapsed(panel: CollapsiblePanel): boolean {
  const ui = useEditorUiStore.getState();
  return panel === "library" ? ui.libraryCollapsed : ui.inspectorCollapsed;
}

/**
 * 展开面板（已展开时不变）。没有句柄时（例如测试只渲染了部分界面）只回写状态。
 *
 * @param panel 面板。
 */
export function expandPanel(panel: CollapsiblePanel): void {
  const h = handles[panel];
  if (h) {
    if (h.isCollapsed()) h.expand();
  }
  useEditorUiStore.getState().setPanelCollapsed(panel, false);
}

/**
 * 收起面板。
 *
 * @param panel 面板。
 */
export function collapsePanel(panel: CollapsiblePanel): void {
  const h = handles[panel];
  if (h && !h.isCollapsed()) h.collapse();
  useEditorUiStore.getState().setPanelCollapsed(panel, true);
}

/**
 * 收起 / 展开面板。
 *
 * @param panel 面板。
 */
export function togglePanel(panel: CollapsiblePanel): void {
  if (isPanelCollapsed(panel)) expandPanel(panel);
  else collapsePanel(panel);
}

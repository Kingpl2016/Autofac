import { useEffect, useRef, type ReactNode } from "react";
import { useDefaultLayout, usePanelRef, type PanelImperativeHandle } from "react-resizable-panels";

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { registerPanel, type CollapsiblePanel } from "../hooks/panelControl";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { InspectorRail, INSPECTOR_RAIL_PX } from "./InspectorRail";

interface EditorColumnsProps {
  library: ReactNode;
  preview: ReactNode;
  inspector: ReactNode;
}

/**
 * 编辑器中部的三栏（素材库 | 预览 | 属性），VS Code 式可收起：
 *
 * - 素材库收起后宽度为 0（左侧图标栏在分栏之外，始终可见）；属性面板收起后留一条窄边（竖排标签）；
 * - 把分隔条拖到最小宽度以下也会收起；
 * - 宽度与收起状态记在 `localStorage`（键 `editor-columns`），下次打开时恢复。
 */
export function EditorColumns({ library, preview, inspector }: EditorColumnsProps) {
  const libraryRef = usePanelRef();
  const inspectorRef = usePanelRef();
  const groupEl = useRef<HTMLDivElement>(null);
  const inspectorCollapsed = useEditorUiStore((s) => s.inspectorCollapsed);
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: "editor-columns", storage: localStorage });

  useEffect(() => {
    registerPanel("library", libraryRef.current);
    registerPanel("inspector", inspectorRef.current);
    // 挂载时按恢复出来的布局回写收起状态（容器还没布局时跳过）
    syncCollapsed("library", libraryRef.current, groupEl.current);
    syncCollapsed("inspector", inspectorRef.current, groupEl.current);
    return () => {
      registerPanel("library", null);
      registerPanel("inspector", null);
    };
  }, [libraryRef, inspectorRef]);

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      className="min-w-0 flex-1"
      elementRef={groupEl}
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
    >
      <ResizablePanel
        id="library"
        panelRef={libraryRef}
        defaultSize={280}
        minSize={200}
        maxSize="40%"
        collapsible
        collapsedSize={0}
        onResize={() => syncCollapsed("library", libraryRef.current, groupEl.current)}
      >
        {library}
      </ResizablePanel>
      <ResizableHandle axis="x" />
      <ResizablePanel id="preview" minSize="25%">
        {preview}
      </ResizablePanel>
      <ResizableHandle axis="x" />
      <ResizablePanel
        id="inspector"
        panelRef={inspectorRef}
        defaultSize={340}
        minSize={260}
        maxSize="40%"
        collapsible
        collapsedSize={INSPECTOR_RAIL_PX}
        onResize={() => syncCollapsed("inspector", inspectorRef.current, groupEl.current)}
      >
        {inspectorCollapsed ? <InspectorRail /> : inspector}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

/**
 * 把面板的收起状态回写到 store（图标栏的 `aria-expanded`、属性面板的窄边都看它）。
 * 容器宽度为 0（还没布局，或测试环境）时不回写，避免误判成“已收起”。
 *
 * @param panel 面板。
 * @param handle 面板句柄。
 * @param group 面板组元素。
 */
function syncCollapsed(panel: CollapsiblePanel, handle: PanelImperativeHandle | null, group: HTMLElement | null): void {
  if (!handle || (group?.offsetWidth ?? 0) === 0) return;
  useEditorUiStore.getState().setPanelCollapsed(panel, handle.isCollapsed());
}

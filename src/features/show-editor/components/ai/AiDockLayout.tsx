import { lazy, Suspense, useEffect, useRef, type ReactNode } from "react";
import { useDefaultLayout, usePanelRef, type PanelImperativeHandle } from "react-resizable-panels";
import { Loader2 } from "lucide-react";

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { registerPanel } from "../../hooks/panelControl";
import { useEditorUiStore } from "../../stores/useEditorUiStore";

/** 对话栏引入 AI SDK / assistant-ui，打开时才加载。 */
const AiDock = lazy(() => import("./AiDock").then((m) => ({ default: m.AiDock })));

/** 对话栏的最小宽度（像素；从收起展开时也是这个宽度，之后拖动的宽度会记住）。 */
const DOCK_MIN_PX = 360;

/**
 * 编辑器主体 + 右侧 AI 对话栏（Cursor / VS Code Copilot 式）：对话栏从工具条下方一直到时间线底部，
 * 可拖动宽度、可收起（默认收起，宽度与收起状态记在 `localStorage` 的 `editor-ai-dock`）。
 * 收起时不渲染对话内容，AI 相关的包也不加载。
 *
 * @param props 编辑器主体。
 */
export function AiDockLayout({ children }: { children: ReactNode }) {
  const dockRef = usePanelRef();
  const groupEl = useRef<HTMLDivElement>(null);
  const collapsed = useEditorUiStore((s) => s.aiCollapsed);
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: "editor-ai-dock", storage: localStorage });

  useEffect(() => {
    registerPanel("ai", dockRef.current);
    sync(dockRef.current, groupEl.current);
    return () => registerPanel("ai", null);
  }, [dockRef]);

  return (
    <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1" elementRef={groupEl} defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged}>
      <ResizablePanel id="main" minSize="40%">
        {children}
      </ResizablePanel>
      <ResizableHandle axis="x" className={collapsed ? "pointer-events-none opacity-0" : undefined} />
      <ResizablePanel
        id="ai"
        panelRef={dockRef}
        defaultSize={defaultLayout ? undefined : 0}
        minSize={DOCK_MIN_PX}
        maxSize="50%"
        collapsible
        collapsedSize={0}
        onResize={() => sync(dockRef.current, groupEl.current)}
      >
        {!collapsed && (
          <Suspense fallback={<Loader2 className="m-4 size-4 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden />}>
            <AiDock />
          </Suspense>
        )}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

/**
 * 把对话栏的收起状态回写到 store。容器还没布局（宽度 0，或测试环境）时不回写。
 *
 * @param handle 面板句柄。
 * @param group 面板组元素。
 */
function sync(handle: PanelImperativeHandle | null, group: HTMLElement | null): void {
  if (!handle || (group?.offsetWidth ?? 0) === 0) return;
  useEditorUiStore.getState().setPanelCollapsed("ai", handle.isCollapsed());
}

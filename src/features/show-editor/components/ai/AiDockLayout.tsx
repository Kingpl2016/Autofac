import { lazy, Suspense, useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { Loader2 } from "lucide-react";

import { registerPanel } from "../../hooks/panelControl";
import { useEditorUiStore } from "../../stores/useEditorUiStore";

/** 对话栏引入 AI SDK / assistant-ui，打开时才加载。 */
const AiDock = lazy(() => import("./AiDock").then((m) => ({ default: m.AiDock })));

/** 对话栏的最小宽度（像素）。 */
const DOCK_MIN_PX = 360;
/** 对话栏最多占编辑器宽度的比例。 */
const DOCK_MAX_RATIO = 0.7;
/** 默认宽度（像素）。 */
const DOCK_DEFAULT_PX = 420;
/** 方向键每次调整的宽度（像素）。 */
const DOCK_STEP_PX = 24;
/** 记住宽度的 `localStorage` 键。 */
const WIDTH_KEY = "editor-ai-dock-width";

/** 读出上次的宽度（没有或无效时用默认值）。 */
function savedWidth(): number {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(v) && v >= DOCK_MIN_PX ? v : DOCK_DEFAULT_PX;
  } catch {
    return DOCK_DEFAULT_PX;
  }
}

/**
 * 编辑器主体 + 悬浮在右侧的 AI 对话栏：打开时浮在编辑器上方（从工具条下方一直到时间线底部），
 * 不挤压编辑器布局；左边缘可拖动调宽（宽度记在 `localStorage` 的 `editor-ai-dock-width`），默认收起。
 * 收起时不渲染对话内容，AI 相关的包也不加载。
 *
 * @param props 编辑器主体。
 */
export function AiDockLayout({ children }: { children: ReactNode }) {
  const collapsed = useEditorUiStore((s) => s.aiCollapsed);
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(savedWidth);

  // 悬浮面板没有 react-resizable-panels 句柄：开关只走 store（见 panelControl）
  useEffect(() => registerPanel("ai", null), []);

  /** 按编辑器当前宽度限制对话栏宽度。 */
  const clamp = useCallback((px: number) => {
    const max = Math.max(DOCK_MIN_PX, (host.current?.clientWidth ?? 0) * DOCK_MAX_RATIO);
    return Math.round(Math.min(Math.max(px, DOCK_MIN_PX), max));
  }, []);

  const commit = useCallback(
    (px: number) => {
      const next = clamp(px);
      setWidth(next);
      try {
        localStorage.setItem(WIDTH_KEY, String(next));
      } catch {
        // 存不了就只在本次会话生效
      }
    },
    [clamp],
  );

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const right = host.current?.getBoundingClientRect().right ?? window.innerWidth;
    const move = (ev: globalThis.PointerEvent) => setWidth(clamp(right - ev.clientX));
    const up = (ev: globalThis.PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      commit(right - ev.clientX);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // 手柄在左边缘：向左变宽，向右变窄
    if (e.key === "ArrowLeft") commit(width + DOCK_STEP_PX);
    else if (e.key === "ArrowRight") commit(width - DOCK_STEP_PX);
    else return;
    e.preventDefault();
  };

  return (
    <div ref={host} className="relative min-h-0 flex-1">
      {children}
      {!collapsed && (
        <aside
          className="absolute inset-y-0 right-0 z-40 flex max-w-full bg-surface-2 shadow-2xl duration-150 animate-in fade-in-0 slide-in-from-right-4 motion-reduce:animate-none"
          style={{ width }}
        >
          <div
            role="separator"
            aria-orientation="vertical"
            aria-valuenow={width}
            aria-valuemin={DOCK_MIN_PX}
            tabIndex={0}
            className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none transition-colors hover:bg-primary/40 focus-visible:bg-primary/60 focus-visible:outline-none"
            onPointerDown={onPointerDown}
            onKeyDown={onKeyDown}
          />
          <div className="min-w-0 flex-1">
            <Suspense fallback={<Loader2 className="m-4 size-4 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden />}>
              <AiDock />
            </Suspense>
          </div>
        </aside>
      )}
    </div>
  );
}

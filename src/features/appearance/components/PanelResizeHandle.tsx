import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";

import { clampPanelWidth, PANEL_WIDTH, usePanelPrefsStore } from "../stores/usePanelPrefsStore";

/** 键盘每次调整的宽度，单位 rem。 */
const KEY_STEP = 2;

/** 读取根字号（px），用于把鼠标位置换算成 rem；界面缩放会改变根字号。 */
function rootFontSize(): number {
  const size = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(size) && size > 0 ? size : 16;
}

/**
 * 面板宽度拖拽手柄：鼠标拖动或键盘方向键调整宽度，宽度会被记住。
 *
 * 语义为可聚焦的垂直分隔条（`role="separator"`，带 `aria-valuenow`）：
 * 向左拖动或按 ← 变宽，向右拖动或按 → 变窄，Home / End 直达最窄 / 最宽。
 * 只在 sm 及以上屏幕显示，窄屏面板始终铺满。
 */
export function PanelResizeHandle() {
  const { t } = useTranslation();
  const width = usePanelPrefsStore((s) => s.width);
  const setWidth = usePanelPrefsStore((s) => s.setWidth);
  const dragging = useRef(false);
  const frame = useRef(0);

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const clientX = event.clientX;
    // 用 rAF 合并同一帧内的多次移动，避免频繁写入持久化存储
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => setWidth((window.innerWidth - clientX) / rootFontSize()));
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next: Record<string, number> = {
      ArrowLeft: width + KEY_STEP,
      ArrowRight: width - KEY_STEP,
      Home: PANEL_WIDTH.min,
      End: PANEL_WIDTH.max,
    };
    const target = next[event.key];
    if (target === undefined) return;
    event.preventDefault();
    setWidth(clampPanelWidth(target));
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t("appearance.panel.resize")}
      aria-valuemin={PANEL_WIDTH.min}
      aria-valuemax={PANEL_WIDTH.max}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onKeyDown={handleKeyDown}
      className="group absolute inset-y-0 left-0 z-10 hidden w-2 -translate-x-1/2 cursor-col-resize touch-none items-center justify-center outline-none sm:flex"
    >
      <span
        aria-hidden
        className="h-10 w-1 rounded-full bg-border transition-colors group-hover:bg-foreground/40 group-focus-visible:bg-ring"
      />
    </div>
  );
}

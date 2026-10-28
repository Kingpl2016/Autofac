import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { TRACK_HEADER_WIDTH, clampHeaderWidth } from "../stores/useEditorPrefsStore";

/** 方向键一次调整的宽度（像素）；按住 Shift 时为 `BIG_STEP`。 */
const STEP = 8;
const BIG_STEP = 32;

interface HeaderResizerProps {
  /** 当前宽度（像素） */
  width: number;
  /**
   * 拖动中的预览宽度（不保存）。
   *
   * @param px 宽度。
   */
  onPreview: (px: number) => void;
  /**
   * 提交宽度（松手、按键、双击时调用一次，保存到偏好）。
   *
   * @param px 宽度。
   */
  onCommit: (px: number) => void;
}

/**
 * 轨道名称列右边缘的拖动条：拖动改宽度，双击恢复默认；键盘 ←/→ 调整（Shift 一次 32 px），Home / End 到两端。
 * 语义为可聚焦的 `separator`（带当前值与范围）。
 */
export function HeaderResizer({ width, onPreview, onCommit }: HeaderResizerProps) {
  const { t } = useTranslation();
  const drag = useRef<{ x: number; w: number; last: number } | null>(null);

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, w: width, last: width };
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.last = clampHeaderWidth(d.w + e.clientX - d.x);
    onPreview(d.last);
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && d.last !== d.w) onCommit(d.last);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? BIG_STEP : STEP;
    let next: number;
    if (e.key === "ArrowLeft") next = width - step;
    else if (e.key === "ArrowRight") next = width + step;
    else if (e.key === "Home") next = TRACK_HEADER_WIDTH.min;
    else if (e.key === "End") next = TRACK_HEADER_WIDTH.max;
    else return;
    e.preventDefault();
    e.stopPropagation();
    onCommit(clampHeaderWidth(next));
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={t("editor.timeline.headerWidth")}
      aria-valuemin={TRACK_HEADER_WIDTH.min}
      aria-valuemax={TRACK_HEADER_WIDTH.max}
      aria-valuenow={width}
      title={t("editor.timeline.headerWidthHint")}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onDoubleClick={() => onCommit(TRACK_HEADER_WIDTH.default)}
      onKeyDown={onKey}
      className={cn(
        "absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize touch-none",
        "after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent after:transition-colors",
        "hover:after:bg-primary/60 focus-visible:outline-none focus-visible:after:w-0.5 focus-visible:after:bg-ring",
      )}
    />
  );
}

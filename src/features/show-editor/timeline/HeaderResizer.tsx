import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { ResizeSeparator } from "@/shared/components/ResizeSeparator";
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
 */
export function HeaderResizer({ width, onPreview, onCommit }: HeaderResizerProps) {
  const { t } = useTranslation();
  return (
    <ResizeSeparator
      orientation="vertical"
      value={width}
      min={TRACK_HEADER_WIDTH.min}
      max={TRACK_HEADER_WIDTH.max}
      label={t("editor.timeline.headerWidth")}
      title={t("editor.timeline.headerWidthHint")}
      step={STEP}
      bigStep={BIG_STEP}
      increaseKey="ArrowRight"
      dragValue={(start, p) => start.value + p.clientX - start.x}
      normalize={clampHeaderWidth}
      onPreview={onPreview}
      onCommit={onCommit}
      defaultValue={TRACK_HEADER_WIDTH.default}
      className={cn(
        "absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize touch-none",
        "after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent after:transition-colors",
        "hover:after:bg-primary/60 focus-visible:outline-none focus-visible:after:w-0.5 focus-visible:after:bg-ring",
      )}
    />
  );
}

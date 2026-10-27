import { memo, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { cssColor } from "../lib/cueTemplates";
import { lookKeyTimes } from "../lib/keyframes";
import { clipColor } from "../lib/looks";
import type { Cue, Preset } from "../lib/project";
import { formatTimecode } from "../lib/time";
import { CueBlock } from "./CueBlock";

/** 片段宽度小于这个值时不显示裁剪手柄（避免抓不到片段本身）。 */
const MIN_HANDLE_WIDTH_PX = 18;

interface ClipViewProps {
  cue: Cue;
  /** 所在轨道名（无障碍名称用） */
  trackName: string;
  left: number;
  top: number;
  width: number;
  height: number;
  selected: boolean;
  locked: boolean;
  dimmed: boolean;
  /** 所在轨道折叠：只画一条色带 */
  collapsed: boolean;
  /** 正在被拖动（预览位置） */
  dragging: boolean;
  /** 拖动预览放不下（与邻居重叠等） */
  invalid: boolean;
  presets: readonly Preset[];
  /** 实际输出色带（CSS 渐变，引擎采样）；尚未采样时为 `null` */
  strip: string | null;
}

/** 片段类型的强调色（顶部细条），区分灯光 / 场景 / 特效。 */
const KIND_ACCENT: Record<Cue["kind"], string> = {
  static: "bg-clip-light",
  look: "bg-clip-light",
  scene: "bg-clip-scene",
  effect: "bg-clip-effect",
};

/** 色带高度（像素）。 */
const STRIP_HEIGHT = 6;

/**
 * 时间线上的一个片段（剪映式）：顶部类型色条 + 强度包络（`CueBlock`）+ 底部实际输出色带 + 左右裁剪手柄。
 * 折叠的轨道只画一条色带。
 *
 * 指针交互由轨道区统一处理（事件委托），这里只用 `data-cue-id` / `data-edge` 标出命中区域。
 */
export const ClipView = memo(function ClipView({
  cue,
  trackName,
  left,
  top,
  width,
  height,
  selected,
  locked,
  dimmed,
  collapsed,
  dragging,
  invalid,
  presets,
  strip,
}: ClipViewProps) {
  const { t } = useTranslation();
  const label = t("editor.timeline.clipLabel", {
    track: trackName,
    start: formatTimecode(cue.startMs),
    end: formatTimecode(cue.endMs),
    brightness: Math.round(cue.brightness),
  });
  const handles = !locked && !collapsed && width >= MIN_HANDLE_WIDTH_PX;
  const length = Math.max(1, cue.endMs - cue.startMs);
  // 外观片段的关键帧画成 ◆（宽度太窄时不画）
  const keyTimes = cue.kind === "look" && width >= MIN_HANDLE_WIDTH_PX ? lookKeyTimes(cue.look).filter((t) => t <= length) : [];

  return (
    <div
      role="button"
      tabIndex={-1}
      aria-label={label}
      aria-pressed={selected}
      data-cue-id={cue.id}
      className={cn(
        "group absolute overflow-hidden rounded-[5px] border bg-surface-1/60",
        locked ? "cursor-default" : "cursor-grab",
        selected ? "border-foreground ring-1 ring-foreground/70" : "border-border/70",
        dragging && "z-10 cursor-grabbing shadow-lg",
        invalid && "border-destructive ring-1 ring-destructive",
      )}
      style={{ left, top, width: Math.max(2, width), height }}
    >
      {collapsed ? (
        <div
          aria-hidden
          className={cn("h-full w-full bg-(--clip-color) opacity-80", dimmed && "opacity-40")}
          style={{ "--clip-color": strip ?? cssColor(clipColor(cue, presets)) } as CSSProperties}
        />
      ) : (
        <>
          <span aria-hidden className={cn("absolute inset-x-0 top-0 z-[1] h-0.5", KIND_ACCENT[cue.kind])} />
          <div className="absolute inset-x-0 top-0" style={{ bottom: strip ? STRIP_HEIGHT : 0 }}>
            <CueBlock cue={cue} dimmed={dimmed} locked={locked} selected={selected && !dragging} />
          </div>
          {keyTimes.map((tMs) => (
            <span
              key={tMs}
              aria-hidden
              data-testid="clip-key"
              className="pointer-events-none absolute z-[2] size-2 -translate-x-1/2 rotate-45 border border-background bg-keyframe"
              style={{ left: `${(tMs / length) * 100}%`, bottom: (strip ? STRIP_HEIGHT : 0) + 2 }}
            />
          ))}
          {strip && (
            <span
              aria-hidden
              data-testid="clip-strip"
              className={cn("absolute inset-x-0 bottom-0 bg-(--strip)", dimmed && "opacity-40")}
              style={{ height: STRIP_HEIGHT, "--strip": strip } as CSSProperties}
            />
          )}
        </>
      )}
      {handles && (
        <>
          <span
            aria-hidden
            data-edge="start"
            className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-foreground/0 transition-colors group-hover:bg-foreground/25"
          />
          <span
            aria-hidden
            data-edge="end"
            className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-foreground/0 transition-colors group-hover:bg-foreground/25"
          />
        </>
      )}
    </div>
  );
});

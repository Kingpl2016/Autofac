import { useRef, useState, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { updateCues } from "../lib/cueOps";
import { cssColor, effectBackground } from "../lib/cueTemplates";
import { clipColor } from "../lib/looks";
import { trackFixtureIds } from "../lib/ops";
import type { Cue } from "../lib/project";
import { clamp } from "../lib/time";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";

interface CueBlockProps {
  cue: Cue;
  /** 所在轨道被静音（降低显示强度） */
  dimmed: boolean;
  /** 被选中时显示淡入淡出手柄 */
  selected: boolean;
  /** 所在轨道被锁定（不显示手柄） */
  locked: boolean;
}

/** 正在拖动的手柄。 */
interface FadeDrag {
  side: "in" | "out";
  startX: number;
  startValue: number;
  value: number;
}

/**
 * Cue 在时间线上的外观：一个“梯形”表示强度包络 —— 左侧斜坡是淡入，顶部平台高度对应亮度，
 * 右侧斜坡是淡出；填充色就是 Cue 的颜色。选中后，两个斜坡的顶点出现可拖动的手柄，
 * 直接拖出淡入 / 淡出时长（也可以在属性面板里精确输入）。
 *
 * 形状用 `clip-path` 裁出，填充直接取 Cue 的颜色（用户数据，不是主题色）；特效用它的颜色拼成渐变
 * （彩虹 / 渐变按周期重复，与输出一致），并在左上角标出名称。
 */
export function CueBlock({ cue, dimmed, selected, locked }: CueBlockProps) {
  const { t } = useTranslation();
  const pxPerSec = useEditorUiStore((s) => s.pxPerSec);
  const [drag, setDrag] = useState<FadeDrag | null>(null);
  const dragRef = useRef<FadeDrag | null>(null);

  const length = Math.max(1, cue.endMs - cue.startMs);
  const fadeIn = drag?.side === "in" ? drag.value : cue.fadeInMs;
  const fadeOut = drag?.side === "out" ? drag.value : cue.fadeOutMs;
  const top = 100 - cue.brightness;
  const rampIn = (fadeIn / length) * 100;
  const rampOutStart = 100 - (fadeOut / length) * 100;
  const presets = useProjectStore((s) => s.project.presets);
  const tempo = useProjectStore((s) => s.project.tempo);
  const gamma = useProjectStore((s) => s.project.output.gamma);
  // 特效的相位扩散按轨道成员错开：填充显示第一台灯的相位
  const members = useProjectStore((s) => {
    if (cue.kind !== "effect") return 1;
    const track = s.project.tracks.find((tr) => tr.id === cue.trackId);
    return track ? Math.max(1, trackFixtureIds(s.project, track).length) : 1;
  });
  const color = cue.kind === "effect" ? effectBackground(cue, { tempo, members }) : cssColor(clipColor(cue, presets, gamma));
  const shape = `polygon(0% 100%, ${rampIn}% ${top}%, ${rampOutStart}% ${top}%, 100% 100%)`;

  const begin = (side: "in" | "out") => (e: PointerEvent<HTMLElement>) => {
    // 阻止事件继续传给时间线库，否则会被当成拖动整个块
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const startValue = side === "in" ? cue.fadeInMs : cue.fadeOutMs;
    const next = { side, startX: e.clientX, startValue, value: startValue };
    dragRef.current = next;
    setDrag(next);
  };

  const move = (e: PointerEvent<HTMLElement>) => {
    const current = dragRef.current;
    if (!current) return;
    const deltaMs = ((e.clientX - current.startX) / pxPerSec) * 1000 * (current.side === "in" ? 1 : -1);
    const other = current.side === "in" ? cue.fadeOutMs : cue.fadeInMs;
    const next = { ...current, value: Math.round(clamp(current.startValue + deltaMs, 0, length - other)) };
    dragRef.current = next;
    setDrag(next);
  };

  const end = () => {
    const current = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!current || current.value === current.startValue) return;
    useProjectStore.getState().update((d) => {
      updateCues(d, [cue.id], current.side === "in" ? { fadeInMs: current.value } : { fadeOutMs: current.value });
    });
  };

  const showHandles = selected && !locked;
  const handle = (side: "in" | "out") => (
    <span
      role="presentation"
      title={t(side === "in" ? "editor.cue.dragFadeIn" : "editor.cue.dragFadeOut")}
      className="absolute z-10 size-2.5 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-full border-2 border-background bg-foreground"
      style={{ left: `${side === "in" ? rampIn : rampOutStart}%`, top: `${top}%` }}
      onPointerDown={begin(side)}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onMouseDown={(e) => e.stopPropagation()}
    />
  );

  return (
    <div
      className={cn("relative h-full w-full overflow-hidden rounded-sm", dimmed && "opacity-40")}
    >
      <div
        aria-hidden
        className="absolute inset-0 opacity-90"
        style={{ clipPath: shape, background: color }}
      />
      <span className="num pointer-events-none absolute left-2.5 top-0.5 select-none text-xs font-medium text-foreground mix-blend-difference">
        {cue.kind === "effect" && `${t(`editor.effects.${cue.effect}`)} · `}
        {Math.round(cue.brightness)}%
      </span>
      {showHandles && handle("in")}
      {showHandles && handle("out")}
    </div>
  );
}

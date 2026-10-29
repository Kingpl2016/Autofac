import { useMemo, useRef } from "react";

import { useElementSize } from "@/shared/hooks/useElementSize";
import { beatsBetween } from "../lib/tempo";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";
import { START_LEFT } from "./timelineData";
import { useTimelineScrollStore } from "./timelineScrollStore";

/** 相邻两条线至少隔这么多像素才画（太密只会糊成一片）。 */
const MIN_LINE_GAP_PX = 6;

/**
 * 节拍网格：在轨道区上方叠一层细竖线，小节线更醒目。只在设置了 BPM 时显示。
 *
 * 只画可见范围内的线，随横向滚动和缩放重绘；不拦截指针事件。
 */
export function BeatGrid() {
  const tempo = useProjectStore((s) => s.project.tempo);
  const durationMs = useProjectStore((s) => s.project.durationMs);
  const pxPerSec = useEditorUiStore((s) => s.pxPerSec);
  const scrollLeft = useTimelineScrollStore((s) => s.left);
  const ref = useRef<HTMLDivElement>(null);
  const { width } = useElementSize(ref);


  const lines = useMemo(() => {
    if (!tempo || width === 0) return [];
    const fromMs = ((scrollLeft - START_LEFT) / pxPerSec) * 1000;
    const toMs = Math.min(durationMs, fromMs + (width / pxPerSec) * 1000);
    const beatPx = (60_000 / tempo.bpm / 1000) * pxPerSec;
    const barPx = beatPx * tempo.beatsPerBar;
    if (barPx < MIN_LINE_GAP_PX) return [];
    return beatsBetween(tempo, fromMs, toMs, 1500)
      .filter((b) => b.isBar || beatPx >= MIN_LINE_GAP_PX)
      .map((b) => ({
        key: b.index,
        x: START_LEFT + (b.timeMs / 1000) * pxPerSec - scrollLeft,
        isBar: b.isBar,
      }));
  }, [tempo, durationMs, pxPerSec, scrollLeft, width]);

  return (
    <div ref={ref} aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <svg className="h-full w-full">
        {lines.map((l) => (
          <line
            key={l.key}
            x1={l.x}
            x2={l.x}
            y1={0}
            y2="100%"
            className={l.isBar ? "stroke-foreground/25" : "stroke-foreground/10"}
          />
        ))}
      </svg>
    </div>
  );
}

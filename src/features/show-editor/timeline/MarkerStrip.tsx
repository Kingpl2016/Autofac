import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { Flag } from "lucide-react";

import { cn } from "@/lib/utils";
import { announce } from "@/shared/stores/announcerStore";
import { moveMarker, removeMarker, renameMarker, setLoopRange } from "../lib/ops";
import type { Marker, Section } from "../lib/project";
import { removeSection, updateSection } from "../lib/sections";
import { formatTimecode } from "../lib/time";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";
import { CommitInput } from "../components/CommitInput";
import { START_LEFT } from "./timelineData";
import { useTimelineScrollStore } from "./timelineScrollStore";

/** 标记点条的高度（像素），需与轨道头列顶部的占位一致。 */
export const MARKER_STRIP_HEIGHT = 24;

/** 指针移动超过这个距离才算拖动，否则当作点击。 */
const DRAG_THRESHOLD_PX = 3;

interface MarkerFlagProps {
  marker: Marker;
  left: number;
}

/**
 * 一个标记点：点击定位播放头，拖动改变位置，双击（或 Enter / F2）改名，Delete 删除。
 */
function MarkerFlag({ marker, left }: MarkerFlagProps) {
  const { t } = useTranslation();
  const pxPerSec = useEditorUiStore((s) => s.pxPerSec);
  const setPlayhead = useEditorUiStore((s) => s.setPlayhead);
  const update = useProjectStore((s) => s.update);
  const [editing, setEditing] = useState(false);
  const [dragTime, setDragTime] = useState<number | null>(null);
  const start = useRef<{ x: number; time: number; moved: boolean } | null>(null);

  const shownLeft = dragTime === null ? left : left + ((dragTime - marker.timeMs) / 1000) * pxPerSec;

  const onDown = (e: PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, time: marker.timeMs, moved: false };
  };
  const onMove = (e: PointerEvent<HTMLButtonElement>) => {
    const s = start.current;
    if (!s) return;
    if (!s.moved && Math.abs(e.clientX - s.x) < DRAG_THRESHOLD_PX) return;
    s.moved = true;
    setDragTime(Math.max(0, s.time + ((e.clientX - s.x) / pxPerSec) * 1000));
  };
  const onUp = () => {
    const s = start.current;
    start.current = null;
    if (!s) return;
    if (s.moved && dragTime !== null) {
      update((d) => void moveMarker(d, marker.id, dragTime));
    } else {
      setPlayhead(marker.timeMs);
    }
    setDragTime(null);
  };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Delete" || e.key === "Backspace") {
      update((d) => removeMarker(d, marker.id));
    } else if (e.key === "Enter" || e.key === "F2") {
      setEditing(true);
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="absolute top-0 z-10 flex h-full items-center gap-1" style={{ left: shownLeft }}>
      <button
        type="button"
        aria-label={t("editor.markers.flagLabel", { name: marker.label, time: formatTimecode(marker.timeMs) })}
        title={`${marker.label} · ${formatTimecode(marker.timeMs)}`}
        className={cn(
          "-ml-1.5 flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm text-primary",
          "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          dragTime !== null && "bg-accent",
        )}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onKeyDown={onKey}
        onDoubleClick={() => setEditing(true)}
      >
        <Flag className="size-3.5" aria-hidden />
      </button>
      {editing ? (
        <span
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "Escape") setEditing(false);
          }}
        >
          <CommitInput
            className="h-5 w-24 px-1 text-xs"
            label={t("editor.markers.rename")}
            value={marker.label}
            onCommit={(label) => update((d) => renameMarker(d, marker.id, label))}
          />
        </span>
      ) : (
        <span className="max-w-24 truncate text-xs text-muted-foreground">{marker.label}</span>
      )}
    </div>
  );
}

/**
 * 一个段落：半透明色带 + 名字。点击定位到段落开头，双击把 A-B 循环设为这一段，Enter / F2 改名，Delete 删除。
 */
function SectionBand({ section, left, width }: { section: Section; left: number; width: number }) {
  const { t } = useTranslation();
  const setPlayhead = useEditorUiStore((s) => s.setPlayhead);
  const update = useProjectStore((s) => s.update);
  const [editing, setEditing] = useState(false);
  const [r, g, b] = section.color;
  const label = t("editor.sections.bandLabel", {
    name: section.name,
    start: formatTimecode(section.startMs),
    end: formatTimecode(section.endMs),
  });

  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Delete" || e.key === "Backspace") {
      update((d) => removeSection(d, section.id));
    } else if (e.key === "Enter" || e.key === "F2") {
      setEditing(true);
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="absolute inset-y-0" style={{ left, width: Math.max(2, width) }}>
      <button
        type="button"
        aria-label={label}
        title={`${label} · ${t("editor.sections.hint")}`}
        className="absolute inset-0 cursor-pointer border-x border-background/60 bg-(--section-color) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        style={{ "--section-color": `rgb(${r} ${g} ${b} / 0.28)` } as CSSProperties}
        onClick={() => setPlayhead(section.startMs)}
        onDoubleClick={() => {
          update((d) => setLoopRange(d, { startMs: section.startMs, endMs: section.endMs }));
          announce(t("editor.sections.looped", { name: section.name }));
        }}
        onKeyDown={onKey}
      />
      {editing ? (
        <span
          className="absolute left-1 top-0.5"
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "Escape") setEditing(false);
          }}
        >
          <CommitInput
            className="h-5 w-28 px-1 text-xs"
            label={t("editor.sections.rename")}
            value={section.name}
            onCommit={(name) => update((d) => updateSection(d, section.id, { name: name.trim() || section.name }))}
          />
        </span>
      ) : (
        <span className="pointer-events-none absolute left-1 top-1 max-w-full truncate pr-1 text-[10px] font-medium text-foreground/80">
          {section.name}
        </span>
      )}
    </div>
  );
}

/**
 * 标记点条：时间线上方一条细长的带，段落画成半透明色带、标记点画成小旗，随横向滚动 / 缩放移动。
 * 播放过程中按 `M` 可以在播放头处打点，`Shift+M` 在播放头处新建段落。
 */
export function MarkerStrip() {
  const { t } = useTranslation();
  const markers = useProjectStore((s) => s.project.markers);
  const sections = useProjectStore((s) => s.project.sections);
  const pxPerSec = useEditorUiStore((s) => s.pxPerSec);
  const scrollLeft = useTimelineScrollStore((s) => s.left);
  const xOf = (ms: number) => START_LEFT + (ms / 1000) * pxPerSec - scrollLeft;

  return (
    <div
      role="group"
      aria-label={t("editor.markers.label")}
      className="relative shrink-0 overflow-hidden border-b border-border bg-surface-2"
      style={{ height: MARKER_STRIP_HEIGHT }}
    >
      {sections.map((s) => (
        <SectionBand key={s.id} section={s} left={xOf(s.startMs)} width={xOf(s.endMs) - xOf(s.startMs)} />
      ))}
      {markers.map((m) => (
        <MarkerFlag
          key={m.id}
          marker={m}
          left={START_LEFT + (m.timeMs / 1000) * pxPerSec - scrollLeft}
        />
      ))}
    </div>
  );
}

import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { Flag } from "lucide-react";

import { cn } from "@/lib/utils";
import { moveMarker, removeMarker, renameMarker } from "../lib/ops";
import type { Marker } from "../lib/project";
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
    <div className="absolute top-0 flex h-full items-center gap-1" style={{ left: shownLeft }}>
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
 * 标记点条：时间线上方一条细长的带，标记点画成小旗，随横向滚动 / 缩放移动。
 * 播放过程中按 `M` 可以在播放头处打点。
 */
export function MarkerStrip() {
  const { t } = useTranslation();
  const markers = useProjectStore((s) => s.project.markers);
  const pxPerSec = useEditorUiStore((s) => s.pxPerSec);
  const scrollLeft = useTimelineScrollStore((s) => s.left);

  return (
    <div
      role="group"
      aria-label={t("editor.markers.label")}
      className="relative shrink-0 overflow-hidden border-b border-border bg-surface-2"
      style={{ height: MARKER_STRIP_HEIGHT }}
    >
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

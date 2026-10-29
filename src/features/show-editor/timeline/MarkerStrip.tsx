import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { Flag, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { announce } from "@/shared/stores/announcerStore";
import { deleteObject } from "../hooks/timelineObjectActions";
import { moveMarker, renameMarker, setLoopRange } from "../lib/ops";
import type { Marker, Section } from "../lib/project";
import { updateSection } from "../lib/sections";
import { formatTimecode } from "../lib/time";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";
import { useEditorPrefsStore } from "../stores/useEditorPrefsStore";
import { collectSnapTargets, pxToMs, SNAP_THRESHOLD_PX } from "../lib/snap";
import { CommitInput } from "../components/CommitInput";
import { START_LEFT } from "./timelineData";
import { useTimelineScrollStore } from "./timelineScrollStore";

/** 标记点条的高度（像素），需与轨道头列顶部的占位一致。 */
export const MARKER_STRIP_HEIGHT = 24;

/** 指针移动超过这个距离才算拖动，否则当作点击。 */
const DRAG_THRESHOLD_PX = 3;

/** 悬停 / 聚焦 / 选中时才显示的删除按钮。 */
function DeleteButton({ label, visible, onDelete, className }: { label: string; visible: boolean; onDelete: () => void; className?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-delete
      // 不触发外层的拖动 / 点选
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onDelete();
      }}
      className={cn(
        "flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm bg-surface-3/90 text-muted-foreground transition-opacity",
        "hover:bg-destructive hover:text-destructive-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        visible ? "opacity-100" : "opacity-0 group-hover/obj:opacity-100 group-focus-within/obj:opacity-100",
        className,
      )}
    >
      <X className="size-3" aria-hidden />
    </button>
  );
}

interface MarkerFlagProps {
  marker: Marker;
  left: number;
}

/**
 * 一个标记点：点击选中并定位播放头（选中后按 Delete 删除），拖动改变位置，双击（或 Enter / F2）改名；
 * 悬停时出现 × 删除；右键有更多操作。
 */
function MarkerFlag({ marker, left }: MarkerFlagProps) {
  const { t } = useTranslation();
  const pxPerSec = useEditorUiStore((s) => s.pxPerSec);
  const setPlayhead = useEditorUiStore((s) => s.setPlayhead);
  const select = useEditorUiStore((s) => s.selectTimelineObject);
  const selected = useEditorUiStore((s) => s.selectedTimelineObject?.kind === "marker" && s.selectedTimelineObject.id === marker.id);
  const renaming = useEditorUiStore((s) => s.renamingObjectId === marker.id);
  const setRenaming = useEditorUiStore((s) => s.setRenamingObject);
  const update = useProjectStore((s) => s.update);
  const [dragTime, setDragTime] = useState<number | null>(null);
  const start = useRef<{ x: number; time: number; moved: boolean; targets: number[] } | null>(null);

  const shownLeft = dragTime === null ? left : left + ((dragTime - marker.timeMs) / 1000) * pxPerSec;
  const remove = () => void deleteObject({ kind: "marker", id: marker.id });

  const onDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    // 吸附目标（节拍、片段边缘、播放头……）在拖动开始时收集一次；标记点自己不算
    const { project } = useProjectStore.getState();
    const others = { ...project, markers: project.markers.filter((m) => m.id !== marker.id) };
    const targets = collectSnapTargets(others, useEditorUiStore.getState().playheadMs, new Set(), useEditorPrefsStore.getState().snapKinds);
    start.current = { x: e.clientX, time: marker.timeMs, moved: false, targets };
  };
  const onMove = (e: PointerEvent<HTMLButtonElement>) => {
    const s = start.current;
    if (!s) return;
    if (!s.moved && Math.abs(e.clientX - s.x) < DRAG_THRESHOLD_PX) return;
    s.moved = true;
    let time = Math.max(0, s.time + ((e.clientX - s.x) / pxPerSec) * 1000);
    // 与片段拖动一致：吸附开着、没按 Alt 时吸到最近的目标
    if (useEditorUiStore.getState().snapEnabled && !e.altKey) {
      const threshold = pxToMs(SNAP_THRESHOLD_PX, pxPerSec);
      let best: number | null = null;
      for (const t of s.targets) if (Math.abs(t - time) <= threshold && (best === null || Math.abs(t - time) < Math.abs(best - time))) best = t;
      if (best !== null) time = best;
    }
    setDragTime(time);
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
    select({ kind: "marker", id: marker.id });
    setDragTime(null);
  };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Delete" || e.key === "Backspace") remove();
    else if (e.key === "Enter" || e.key === "F2") setRenaming(marker.id);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      data-marker-id={marker.id}
      className="group/obj absolute top-0 z-10 flex h-full items-center gap-1"
      style={{ left: shownLeft }}
    >
      <button
        type="button"
        aria-pressed={selected}
        aria-label={t("editor.markers.flagLabel", { name: marker.label, time: formatTimecode(marker.timeMs) })}
        title={`${marker.label} · ${formatTimecode(marker.timeMs)} · ${t("editor.markers.hint")}`}
        className={cn(
          "-ml-1.5 flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm text-primary",
          "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          (dragTime !== null || selected) && "bg-accent",
          selected && "ring-2 ring-primary",
        )}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onKeyDown={onKey}
        onDoubleClick={() => setRenaming(marker.id)}
      >
        <Flag className={cn("size-3.5", selected && "fill-current")} aria-hidden />
      </button>
      {renaming ? (
        <span
          onBlur={() => setRenaming(null)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "Escape") setRenaming(null);
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
        <>
          <span className={cn("max-w-24 truncate text-xs", selected ? "text-foreground" : "text-muted-foreground")}>{marker.label}</span>
          <DeleteButton label={t("editor.markers.delete", { name: marker.label })} visible={selected} onDelete={remove} />
        </>
      )}
    </div>
  );
}

/**
 * 一个段落：半透明色带 + 名字。点击选中并定位到段落开头（选中后按 Delete 删除），双击把 A-B 循环设为这一段，
 * Enter / F2 改名；悬停时右上角出现 × 删除；右键有更多操作。
 */
function SectionBand({ section, left, width }: { section: Section; left: number; width: number }) {
  const { t } = useTranslation();
  const setPlayhead = useEditorUiStore((s) => s.setPlayhead);
  const select = useEditorUiStore((s) => s.selectTimelineObject);
  const selected = useEditorUiStore((s) => s.selectedTimelineObject?.kind === "section" && s.selectedTimelineObject.id === section.id);
  const renaming = useEditorUiStore((s) => s.renamingObjectId === section.id);
  const setRenaming = useEditorUiStore((s) => s.setRenamingObject);
  const update = useProjectStore((s) => s.update);
  const [r, g, b] = section.color;
  const label = t("editor.sections.bandLabel", {
    name: section.name,
    start: formatTimecode(section.startMs),
    end: formatTimecode(section.endMs),
  });
  const remove = () => void deleteObject({ kind: "section", id: section.id });

  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Delete" || e.key === "Backspace") remove();
    else if (e.key === "Enter" || e.key === "F2") setRenaming(section.id);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div data-section-id={section.id} className="group/obj absolute inset-y-0" style={{ left, width: Math.max(2, width) }}>
      <button
        type="button"
        aria-pressed={selected}
        aria-label={label}
        title={`${label} · ${t("editor.sections.hint")}`}
        className={cn(
          "absolute inset-0 cursor-pointer border-x border-background/60 bg-(--section-color) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          selected && "ring-2 ring-inset ring-primary",
        )}
        style={{ "--section-color": `rgb(${r} ${g} ${b} / ${selected ? 0.45 : 0.28})` } as CSSProperties}
        onClick={() => {
          setPlayhead(section.startMs);
          select({ kind: "section", id: section.id });
        }}
        onDoubleClick={() => {
          update((d) => setLoopRange(d, { startMs: section.startMs, endMs: section.endMs }));
          announce(t("editor.sections.looped", { name: section.name }));
        }}
        onKeyDown={onKey}
      />
      {renaming ? (
        <span
          className="absolute left-1 top-0.5 z-[1]"
          onBlur={() => setRenaming(null)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "Escape") setRenaming(null);
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
        <>
          <span className="pointer-events-none absolute left-1 top-1 max-w-full truncate pr-5 text-[10px] font-medium text-foreground/80">
            {section.name}
          </span>
          {width >= 28 && (
            <DeleteButton
              label={t("editor.sections.delete", { name: section.name })}
              visible={selected}
              onDelete={remove}
              className="absolute right-0.5 top-0.5"
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * 标记点条：时间线上方一条细长的带，段落画成半透明色带、标记点画成小旗，随横向滚动 / 缩放移动。
 * 播放过程中按 `M` 可以在播放头处打点，`Shift+M` 在播放头处新建段落。
 * 删除：点选后按 Delete、悬停 ×，或右键菜单；删除后可撤销。
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
      data-marker-strip
      data-tour="marker-strip"
      className="relative shrink-0 overflow-hidden border-b border-border bg-surface-2"
      style={{ height: MARKER_STRIP_HEIGHT }}
    >
      {sections.map((s) => (
        <SectionBand key={s.id} section={s} left={xOf(s.startMs)} width={xOf(s.endMs) - xOf(s.startMs)} />
      ))}
      {markers.map((m) => (
        <MarkerFlag key={m.id} marker={m} left={xOf(m.timeMs)} />
      ))}
    </div>
  );
}

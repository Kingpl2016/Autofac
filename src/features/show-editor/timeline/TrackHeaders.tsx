import { forwardRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Boxes,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Clapperboard,
  Headphones,
  Lamp,
  Lock,
  LockOpen,
  Trash2,
  Volume2,
  VolumeX,
} from "lucide-react";

import { FIXTURE_TYPE_ICONS } from "@/features/fixtures";
import { cn } from "@/lib/utils";
import type { FixtureType } from "../lib/fixtureProfile";
import type { Track } from "../lib/project";
import { useEditorPrefsStore } from "../stores/useEditorPrefsStore";
import { HeaderResizer } from "./HeaderResizer";
import { MARKER_STRIP_HEIGHT } from "./MarkerStrip";
import { RULER_HEIGHT } from "./timelineData";
import { BODY_BOTTOM_PAD, trackHeight } from "./timelineLayout";

/** 轨道区横向滚动条的预留高度：轨道头要能滚到与轨道区相同的底部。 */
const SCROLLBAR_ALLOWANCE = 16;

/** 轨道头的三个开关。 */
export type TrackFlag = "mute" | "solo" | "lock";

/**
 * 轨道类型图标：灯具轨道按灯具类型（调光 / 白光 / 混色 / 摇头），分组与场景用各自的图标；
 * 颜色与片段类型色一致。灯具类型以 `role="img"` 的名称读出。
 */
function TrackKindIcon({ kind, type }: { kind: Track["target"]["kind"]; type?: FixtureType | null }) {
  const { t } = useTranslation();
  const Icon = kind === "group" ? Boxes : kind === "scene" ? Clapperboard : type ? FIXTURE_TYPE_ICONS[type] : Lamp;
  const label = type ? t(`editor.fixtureType.${type}`) : undefined;
  return (
    <span role={label ? "img" : undefined} aria-label={label} title={label} aria-hidden={label ? undefined : true} className="flex shrink-0">
      <Icon
        aria-hidden
        className={cn(
          "size-3.5 shrink-0",
          kind === "scene" ? "text-clip-scene" : kind === "group" ? "text-primary" : "text-clip-light",
        )}
      />
    </span>
  );
}

interface TrackHeadersProps {
  tracks: readonly Track[];
  /** 轨道显示名（取自绑定的灯具 / 分组），与 `tracks` 一一对应 */
  names: readonly string[];
  selectedTrackId: string | null;
  /** 选中的全部轨道（多选） */
  selectedTrackIds?: readonly string[];
  /** 每条轨道上最多的灯具类型（与 `tracks` 一一对应；省略时不区分） */
  fixtureTypes?: readonly (FixtureType | null)[];
  /**
   * 点选轨道。
   *
   * @param trackId 轨道。
   * @param mode `single` 单选，`toggle` Ctrl / ⌘ 追加或取消，`range` Shift 连选。
   */
  onSelect: (trackId: string, mode?: "single" | "toggle" | "range") => void;
  /** 删除轨道（灯具轨道连同灯具；分组轨道只删分组）；多选时删除全部选中的轨道 */
  onDelete?: (trackId: string) => void;
  onToggle: (trackId: string, flag: TrackFlag) => void;
  /** 折叠 / 展开轨道 */
  onCollapse?: (trackId: string, collapsed: boolean) => void;
  /** 切换轨道高度档位（紧凑 → 普通 → 加高） */
  onCycleHeight?: (trackId: string) => void;
  /** 在轨道头上滚轮时，把纵向滚动交给时间线 */
  onWheelScroll: (deltaY: number) => void;
  /** 标尺与灯光轨道之间的固定内容（媒体轨道头），与时间线右侧的媒体轨道区对齐 */
  topSlot?: ReactNode;
}

/**
 * 时间线左侧的轨道头列：名称与 静音 / 独奏 / 锁定 开关。宽度可在右边缘拖动调整（会记住）。
 *
 * 行高与时间线的轨道行一致（各轨道可以有不同高度），顶部留出标记点条、波形与标尺的高度；
 * 纵向滚动位置由时间线同步（见 ref）。
 */
export const TrackHeaders = forwardRef<HTMLDivElement, TrackHeadersProps>(function TrackHeaders(
  { tracks, names, selectedTrackId, selectedTrackIds, fixtureTypes, onSelect, onDelete, onToggle, onCollapse, onCycleHeight, onWheelScroll, topSlot },
  ref,
) {
  const { t } = useTranslation();
  const savedWidth = useEditorPrefsStore((s) => s.trackHeaderWidth);
  const setWidth = useEditorPrefsStore((s) => s.setTrackHeaderWidth);
  // 拖动中只改本地预览，松手才保存
  const [preview, setPreview] = useState<number | null>(null);
  const width = preview ?? savedWidth;
  return (
    <div
      data-tour="track-headers"
      className="relative flex shrink-0 flex-col border-r border-border bg-surface-2"
      style={{ width }}
    >
      <HeaderResizer
        width={width}
        onPreview={setPreview}
        onCommit={(px) => {
          setPreview(null);
          setWidth(px);
        }}
      />
      <div style={{ height: MARKER_STRIP_HEIGHT + RULER_HEIGHT }} className="shrink-0 border-b border-border" aria-hidden />
      {topSlot}
      <div ref={ref} className="min-h-0 flex-1 overflow-hidden" onWheel={(e) => onWheelScroll(e.deltaY)}>
      <ul style={{ paddingBottom: BODY_BOTTOM_PAD + SCROLLBAR_ALLOWANCE }}>
        {tracks.map((track, i) => {
          const name = names[i] || t("editor.timeline.missingTarget");
          const flags: { flag: TrackFlag; on: boolean; label: string; icon: React.ReactNode }[] = [
            {
              flag: "mute",
              on: track.mute,
              label: track.mute ? t("editor.timeline.unmute", { name }) : t("editor.timeline.mute", { name }),
              icon: track.mute ? <VolumeX aria-hidden /> : <Volume2 aria-hidden />,
            },
            {
              flag: "solo",
              on: track.solo,
              label: track.solo ? t("editor.timeline.unsolo", { name }) : t("editor.timeline.solo", { name }),
              icon: <Headphones aria-hidden />,
            },
            {
              flag: "lock",
              on: track.lock,
              label: track.lock ? t("editor.timeline.unlock", { name }) : t("editor.timeline.lock", { name }),
              icon: track.lock ? <Lock aria-hidden /> : <LockOpen aria-hidden />,
            },
          ];
          const collapsed = track.collapsed ?? false;
          const small = "flex shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
          return (
            <li
              key={track.id}
              data-track-header-id={track.id}
              style={{ height: trackHeight(track) }}
              className={cn(
                "group/track flex items-center gap-1 border-b border-border px-1",
                (selectedTrackIds ?? (selectedTrackId ? [selectedTrackId] : [])).includes(track.id) && "bg-accent",
                track.id === selectedTrackId && "shadow-[inset_2px_0_0_var(--primary)]",
              )}
            >
              {onCollapse && (
                <button
                  type="button"
                  aria-expanded={!collapsed}
                  aria-label={t(collapsed ? "editor.timeline.expand" : "editor.timeline.collapse", { name })}
                  title={t(collapsed ? "editor.timeline.expand" : "editor.timeline.collapse", { name })}
                  onClick={() => onCollapse(track.id, !collapsed)}
                  className={cn(small, collapsed ? "size-4 [&_svg]:size-3" : "size-5 [&_svg]:size-3.5")}
                >
                  {collapsed ? <ChevronRight aria-hidden /> : <ChevronDown aria-hidden />}
                </button>
              )}
              <TrackKindIcon kind={track.target.kind} type={fixtureTypes?.[i]} />
              <button
                type="button"
                onClick={(e) => onSelect(track.id, e.shiftKey ? "range" : e.ctrlKey || e.metaKey ? "toggle" : "single")}
                onKeyDown={(e) => {
                  if ((e.key === "Delete" || e.key === "Backspace") && onDelete) {
                    e.preventDefault();
                    e.stopPropagation();
                    onDelete(track.id);
                  }
                }}
                aria-pressed={(selectedTrackIds ?? (selectedTrackId ? [selectedTrackId] : [])).includes(track.id)}
                aria-label={t("editor.timeline.selectTrack", { name })}
                className={cn(
                  "min-w-0 flex-1 truncate rounded-sm px-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  collapsed ? "text-xs" : "text-sm",
                )}
              >
                {name}
              </button>
              {!collapsed && onCycleHeight && (
                <button
                  type="button"
                  aria-label={t("editor.timeline.cycleHeight", { name })}
                  title={t("editor.timeline.cycleHeight", { name })}
                  onClick={() => onCycleHeight(track.id)}
                  className={cn(small, "size-6 opacity-0 group-hover/track:opacity-100 focus-visible:opacity-100 [&_svg]:size-3.5")}
                >
                  <ChevronsUpDown aria-hidden />
                </button>
              )}
              {!collapsed && flags.map((f) => (
                <button
                  key={f.flag}
                  type="button"
                  aria-pressed={f.on}
                  aria-label={f.label}
                  title={f.label}
                  onClick={() => onToggle(track.id, f.flag)}
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors [&_svg]:size-3.5",
                    "hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    f.on && "bg-primary/20 text-primary",
                  )}
                >
                  {f.icon}
                </button>
              ))}
              {!collapsed && onDelete && (
                <button
                  type="button"
                  aria-label={t("editor.timeline.deleteTrack", { name })}
                  title={t("editor.timeline.deleteTrack", { name })}
                  onClick={() => onDelete(track.id)}
                  className={cn(
                    small,
                    "size-6 opacity-0 hover:text-destructive group-hover/track:opacity-100 focus-visible:opacity-100 [&_svg]:size-3.5",
                  )}
                >
                  <Trash2 aria-hidden />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      </div>
    </div>
  );
});

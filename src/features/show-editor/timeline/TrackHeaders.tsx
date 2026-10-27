import { forwardRef } from "react";
import { useTranslation } from "react-i18next";
import { Lock, LockOpen, VolumeX, Volume2, Headphones } from "lucide-react";

import { cn } from "@/lib/utils";
import type { Track } from "../lib/project";
import { MARKER_STRIP_HEIGHT } from "./MarkerStrip";
import { RULER_HEIGHT, ROW_HEIGHT } from "./timelineData";

/** 轨道头的三个开关。 */
export type TrackFlag = "mute" | "solo" | "lock";

interface TrackHeadersProps {
  tracks: readonly Track[];
  /** 轨道显示名（取自绑定的灯具 / 分组），与 `tracks` 一一对应 */
  names: readonly string[];
  selectedTrackId: string | null;
  onSelect: (trackId: string) => void;
  onToggle: (trackId: string, flag: TrackFlag) => void;
  /** 在轨道头上滚轮时，把纵向滚动交给时间线 */
  onWheelScroll: (deltaY: number) => void;
  /** 顶部额外占位高度（像素）：时间线上方有波形条时与之对齐，默认 0。 */
  extraTop?: number;
}

/**
 * 时间线左侧的轨道头列：名称与 静音 / 独奏 / 锁定 开关。
 *
 * 行高与时间线的轨道行一致，顶部留出标记点条和标尺的高度；纵向滚动位置由时间线同步（见 ref）。
 */
export const TrackHeaders = forwardRef<HTMLDivElement, TrackHeadersProps>(function TrackHeaders(
  { tracks, names, selectedTrackId, onSelect, onToggle, onWheelScroll, extraTop = 0 },
  ref,
) {
  const { t } = useTranslation();
  return (
    <div
      ref={ref}
      className="w-44 shrink-0 overflow-hidden border-r border-border bg-surface-2"
      onWheel={(e) => onWheelScroll(e.deltaY)}
    >
      <div
        style={{ height: MARKER_STRIP_HEIGHT + RULER_HEIGHT + extraTop }}
        className="border-b border-border"
        aria-hidden
      />
      <ul>
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
          return (
            <li
              key={track.id}
              style={{ height: ROW_HEIGHT }}
              className={cn(
                "flex items-center gap-1 border-b border-border px-1.5",
                track.id === selectedTrackId && "bg-accent",
              )}
            >
              <button
                type="button"
                onClick={() => onSelect(track.id)}
                aria-pressed={track.id === selectedTrackId}
                aria-label={t("editor.timeline.selectTrack", { name })}
                className="min-w-0 flex-1 truncate rounded-sm px-1 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {name}
              </button>
              {flags.map((f) => (
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
            </li>
          );
        })}
      </ul>
    </div>
  );
});

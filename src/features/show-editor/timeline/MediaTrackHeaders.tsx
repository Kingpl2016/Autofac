import { useTranslation } from "react-i18next";
import { ChevronsUpDown, Film, Headphones, Lock, LockOpen, Music, Trash2, Volume2, VolumeX } from "lucide-react";

import { cn } from "@/lib/utils";
import { CommitInput } from "../components/CommitInput";
import { removeMediaTrack, setMediaTrack } from "../lib/mediaClips";
import { TRACK_HEIGHT_ORDER } from "../lib/ops";
import { useProjectStore } from "../stores/useProjectStore";
import { mediaLayout, mediaTrackHeight } from "./mediaLayout";

const SMALL =
  "flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors [&_svg]:size-3.5 hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * 媒体轨道的轨道头（与 `MediaLanes` 的行一一对齐）：类型图标、可改名的名称、静音 / 独奏 / 锁定、
 * 高度档位与删除轨道。
 */
export function MediaTrackHeaders() {
  const { t } = useTranslation();
  const tracks = useProjectStore((s) => s.project.mediaTracks);
  const update = useProjectStore((s) => s.update);
  if (tracks.length === 0) return null;

  return (
    <ul
      aria-label={t("editor.mediaTracks.headers")}
      className="shrink-0 overflow-hidden border-b border-border bg-surface-2/60"
      style={{ height: mediaLayout(tracks).total }}
    >
      {tracks.map((track) => {
        const name = track.name || t(`editor.mediaTracks.kinds.${track.kind}`);
        const Icon = track.kind === "video" ? Film : Music;
        const flags = [
          {
            key: "mute" as const,
            on: track.mute,
            label: t(track.mute ? "editor.timeline.unmute" : "editor.timeline.mute", { name }),
            icon: track.mute ? <VolumeX aria-hidden /> : <Volume2 aria-hidden />,
          },
          {
            key: "solo" as const,
            on: track.solo,
            label: t(track.solo ? "editor.timeline.unsolo" : "editor.timeline.solo", { name }),
            icon: <Headphones aria-hidden />,
          },
          {
            key: "lock" as const,
            on: track.lock,
            label: t(track.lock ? "editor.timeline.unlock" : "editor.timeline.lock", { name }),
            icon: track.lock ? <Lock aria-hidden /> : <LockOpen aria-hidden />,
          },
        ];
        const compact = (track.height ?? "normal") === "compact";
        return (
          <li
            key={track.id}
            data-media-track-header-id={track.id}
            style={{ height: mediaTrackHeight(track) }}
            className="group/track flex items-center gap-1 border-b border-border/60 px-1"
          >
            <Icon aria-hidden className={cn("size-3.5 shrink-0", track.kind === "video" ? "text-clip-video" : "text-clip-audio")} />
            <CommitInput
              label={t("editor.mediaTracks.rename", { name })}
              value={track.name}
              className="h-6 min-w-0 flex-1 border-transparent bg-transparent px-1 text-sm shadow-none hover:border-border focus-visible:border-border"
              onCommit={(text) => update((d) => setMediaTrack(d, track.id, { name: text.trim() }))}
            />
            <button
              type="button"
              aria-label={t("editor.timeline.cycleHeight", { name })}
              title={t("editor.timeline.cycleHeight", { name })}
              onClick={() => {
                const current = track.height ?? "normal";
                const next = TRACK_HEIGHT_ORDER[(TRACK_HEIGHT_ORDER.indexOf(current) + 1) % TRACK_HEIGHT_ORDER.length];
                update((d) => setMediaTrack(d, track.id, { height: next }));
              }}
              className={cn(SMALL, "opacity-0 group-hover/track:opacity-100 focus-visible:opacity-100")}
            >
              <ChevronsUpDown aria-hidden />
            </button>
            {flags.map((f) => (
              <button
                key={f.key}
                type="button"
                aria-pressed={f.on}
                aria-label={f.label}
                title={f.label}
                onClick={() => update((d) => setMediaTrack(d, track.id, { [f.key]: !f.on }))}
                className={cn(SMALL, f.on && "bg-primary/20 text-primary", compact && f.key === "lock" && "hidden")}
              >
                {f.icon}
              </button>
            ))}
            <button
              type="button"
              aria-label={t("editor.mediaTracks.remove", { name })}
              title={t("editor.mediaTracks.remove", { name })}
              onClick={() => update((d) => removeMediaTrack(d, track.id))}
              className={cn(SMALL, "opacity-0 hover:text-destructive group-hover/track:opacity-100 focus-visible:opacity-100")}
            >
              <Trash2 aria-hidden />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

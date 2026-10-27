import { useTranslation } from "react-i18next";
import { Scissors, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { announce } from "@/shared/stores/announcerStore";
import { applyMediaPlacements, checkMediaPlacements, removeMediaClips, setMediaClip, setMediaTrack, splitMediaClips } from "../lib/mediaClips";
import type { MediaClip } from "../lib/project";
import { formatTimecode } from "../lib/time";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";
import { CommitInput } from "./CommitInput";
import { PixelMapPanel } from "./PixelMapPanel";
import { SliderField } from "./SliderField";

/** 解析毫秒输入；不是非负有限数字时返回 `null`。 */
function ms(text: string): number | null {
  const v = Math.round(Number(text.trim()));
  return Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * 媒体片段的属性：音量、淡入淡出、静音（多选时一起改），单个片段时还能精确改起点 / 入点 / 长度、
 * 所在轨道的音量，以及在播放头处分割、删除。
 */
export function MediaClipInspector({ clips }: { clips: readonly MediaClip[] }) {
  const { t } = useTranslation();
  const project = useProjectStore((s) => s.project);
  const update = useProjectStore((s) => s.update);
  const ids = clips.map((c) => c.id);
  const first = clips[0];
  const media = project.media.find((m) => m.id === first.mediaId);
  const track = project.mediaTracks.find((tr) => tr.id === first.trackId);
  const same = <T,>(get: (c: MediaClip) => T) => clips.every((c) => get(c) === get(first));

  const place = (patch: Partial<Pick<MediaClip, "startMs" | "inMs" | "durationMs">>) => {
    const next = { id: first.id, trackId: first.trackId, startMs: first.startMs, inMs: first.inMs, durationMs: first.durationMs, ...patch };
    if (!checkMediaPlacements(project, [next])) {
      announce(t("editor.mediaTracks.invalidPlace"));
      return;
    }
    update((d) => applyMediaPlacements(d, [next]));
  };

  const field = (label: string, value: number, onCommit: (v: number) => void) => (
    <label className="flex items-center justify-between gap-2 text-sm">
      <span>{label}</span>
      <span className="flex items-center gap-1">
        <CommitInput
          label={label}
          value={value}
          inputMode="numeric"
          className="num h-7 w-24 px-1.5 text-xs"
          onCommit={(text) => {
            const v = ms(text);
            if (v !== null) onCommit(v);
          }}
        />
        <span className="text-xs text-muted-foreground">ms</span>
      </span>
    </label>
  );

  return (
    <section aria-label={t("editor.mediaTracks.inspector")} className="flex flex-col gap-3 p-3">
      <header className="flex items-center justify-between gap-2">
        <h3 className="min-w-0 truncate text-sm font-medium">
          {clips.length > 1 ? t("editor.mediaTracks.selectedCount", { count: clips.length }) : (media?.name ?? "")}
        </h3>
        <div className="flex gap-1">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label={t("editor.mediaTracks.split")}
            title={t("editor.mediaTracks.split")}
            onClick={() => {
              let created: string[] = [];
              update((d) => {
                created = splitMediaClips(d, ids, useEditorUiStore.getState().playheadMs);
              });
              announce(t(created.length > 0 ? "editor.mediaTracks.splitDone" : "editor.mediaTracks.splitNone"));
            }}
          >
            <Scissors aria-hidden />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7 text-destructive"
            aria-label={t("editor.mediaTracks.removeClips", { count: clips.length })}
            title={t("editor.mediaTracks.removeClips", { count: clips.length })}
            onClick={() => {
              update((d) => removeMediaClips(d, ids));
              useEditorUiStore.getState().selectMediaClips([]);
            }}
          >
            <Trash2 aria-hidden />
          </Button>
        </div>
      </header>

      <SliderField
        label={t("editor.mediaTracks.volume")}
        numberLabel={t("editor.mediaTracks.volumeValue")}
        value={Math.round(first.volume * 100)}
        min={0}
        max={100}
        unit="%"
        mixed={!same((c) => c.volume)}
        mixedLabel={t("editor.cue.mixed")}
        onCommit={(v) => update((d) => setMediaClip(d, ids, { volume: v / 100 }))}
      />
      <SliderField
        label={t("editor.mediaTracks.fadeIn")}
        numberLabel={t("editor.mediaTracks.fadeInValue")}
        value={first.fadeInMs}
        min={0}
        max={Math.max(0, Math.min(10_000, first.durationMs - first.fadeOutMs))}
        step={10}
        unit="ms"
        mixed={!same((c) => c.fadeInMs)}
        mixedLabel={t("editor.cue.mixed")}
        onCommit={(v) => update((d) => setMediaClip(d, ids, { fadeInMs: v }))}
      />
      <SliderField
        label={t("editor.mediaTracks.fadeOut")}
        numberLabel={t("editor.mediaTracks.fadeOutValue")}
        value={first.fadeOutMs}
        min={0}
        max={Math.max(0, Math.min(10_000, first.durationMs - first.fadeInMs))}
        step={10}
        unit="ms"
        mixed={!same((c) => c.fadeOutMs)}
        mixedLabel={t("editor.cue.mixed")}
        onCommit={(v) => update((d) => setMediaClip(d, ids, { fadeOutMs: v }))}
      />
      <label className="flex items-center justify-between gap-2 text-sm">
        <span>{t("editor.mediaTracks.mute")}</span>
        <Switch
          aria-label={t("editor.mediaTracks.mute")}
          checked={first.muted === true}
          onCheckedChange={(on) => update((d) => setMediaClip(d, ids, { muted: on }))}
        />
      </label>

      {clips.length === 1 && (
        <>
          <hr className="border-border" />
          {field(t("editor.mediaTracks.start"), first.startMs, (v) => place({ startMs: v }))}
          {field(t("editor.mediaTracks.in"), first.inMs, (v) => place({ inMs: v }))}
          {field(t("editor.mediaTracks.length"), first.durationMs, (v) => place({ durationMs: v }))}
          <p className="num text-xs text-muted-foreground">
            {t("editor.mediaTracks.span", {
              start: formatTimecode(first.startMs),
              end: formatTimecode(first.startMs + first.durationMs),
              source: formatTimecode(media?.durationMs ?? 0),
            })}
          </p>
          {track && (
            <SliderField
              label={t("editor.mediaTracks.trackVolume", { name: track.name })}
              numberLabel={t("editor.mediaTracks.trackVolumeValue")}
              value={Math.round(track.volume * 100)}
              min={0}
              max={100}
              unit="%"
              onCommit={(v) => update((d) => setMediaTrack(d, track.id, { volume: v / 100 }))}
            />
          )}
          {media?.kind === "video" && <PixelMapPanel clip={first} />}
        </>
      )}
    </section>
  );
}

import { useTranslation } from "react-i18next";
import { Pause, Play, Repeat, Square, Volume2, VolumeX } from "lucide-react";

import { Button } from "@/components/ui/button";
import { stopPlayback, togglePlay } from "../hooks/transportActions";
import { setOutput } from "../lib/ops";
import { formatTimecode } from "../lib/time";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { usePlaybackStore } from "../stores/usePlaybackStore";
import { useProjectStore } from "../stores/useProjectStore";
import { OutputPopover } from "./OutputPopover";
import { PlayheadTimecode } from "./PlayheadTimecode";

/**
 * 工具条中间的传输控制：播放 / 暂停、停止、循环，当前时间 / 总时长，以及输出设置。
 *
 * 播放由后端的 30 FPS 引擎驱动并输出 Art-Net / sACN；这里只发命令、显示后端回报的状态。
 */
export function TransportBar() {
  const { t } = useTranslation();
  const transport = usePlaybackStore((s) => s.state?.transport ?? "stopped");
  const durationMs = useProjectStore((s) => s.project.durationMs);
  const looping = useProjectStore((s) => s.project.output.loop);
  const update = useProjectStore((s) => s.update);
  const hasMedia = useProjectStore((s) => s.project.media.length > 0);
  const muted = useEditorUiStore((s) => s.mediaMuted);
  const toggleMuted = useEditorUiStore((s) => s.toggleMuted);
  const playing = transport === "playing";

  return (
    <div role="group" aria-label={t("editor.playback.group")} className="flex items-center gap-1">
      <Button
        type="button"
        variant={playing ? "secondary" : "ghost"}
        size="icon"
        className="size-8"
        aria-label={playing ? t("editor.playback.pause") : t("editor.playback.play")}
        aria-keyshortcuts="Space"
        title={`${playing ? t("editor.playback.pause") : t("editor.playback.play")} (Space)`}
        onClick={() => void togglePlay()}
      >
        {playing ? <Pause aria-hidden /> : <Play aria-hidden />}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8"
        disabled={transport === "stopped"}
        aria-label={t("editor.playback.stop")}
        title={t("editor.playback.stop")}
        onClick={() => void stopPlayback()}
      >
        <Square aria-hidden />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={looping ? "size-8 bg-primary/20 text-primary" : "size-8"}
        aria-label={t("editor.playback.loop")}
        aria-pressed={looping}
        title={t("editor.playback.loop")}
        onClick={() => update((d) => setOutput(d, { loop: !d.output.loop }))}
      >
        <Repeat aria-hidden />
      </Button>
      {hasMedia && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={muted ? "size-8 bg-primary/20 text-primary" : "size-8"}
          aria-label={t("editor.playback.mute")}
          aria-pressed={muted}
          title={t("editor.playback.mute")}
          onClick={toggleMuted}
        >
          {muted ? <VolumeX aria-hidden /> : <Volume2 aria-hidden />}
        </Button>
      )}
      <span className="num ml-1 flex items-baseline gap-1 text-xs text-muted-foreground">
        <PlayheadTimecode label={t("editor.timeline.playhead")} className="text-foreground" />
        <span aria-hidden>/</span>
        <span aria-label={t("editor.playback.duration")}>{formatTimecode(durationMs)}</span>
      </span>
      <OutputPopover />
    </div>
  );
}

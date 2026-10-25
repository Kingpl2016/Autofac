import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pause, Play, Repeat, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { formatDurationUs } from "../lib/filter";
import { SPEED_STEPS, type PlaybackStatus } from "../lib/types";

/** 拖动进度条时向后端发送 seek 的最小间隔（毫秒）。 */
const SEEK_THROTTLE_MS = 60;

interface TransportBarProps {
  status: PlaybackStatus;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
  onSeek: (posUs: number) => void;
  onSpeed: (milli: number) => void;
  onLoop: (loop: boolean) => void;
}

/** 倍速显示文案，如 `1x`、`0.5x`。 */
function speedLabel(milli: number): string {
  return `${milli / 1000}x`;
}

/**
 * 传输控制条：播放 / 暂停 / 停止、循环、倍速、可拖动的进度条与时间显示。
 *
 * 拖动期间进度条以本地值为准并节流地向后端 seek，松开后回到后端上报的位置。
 */
export function TransportBar({
  status,
  onPlay,
  onPause,
  onStop,
  onSeek,
  onSpeed,
  onLoop,
}: TransportBarProps) {
  const { t } = useTranslation();
  const [dragPos, setDragPos] = useState<number | null>(null);
  const lastSeekAt = useRef(0);
  const trailing = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (trailing.current) clearTimeout(trailing.current);
    },
    [],
  );

  const playing = status.state === "playing";
  const shown = dragPos ?? status.posUs;
  const max = Math.max(status.durationUs, 1);

  const throttledSeek = (pos: number) => {
    const now = performance.now();
    if (trailing.current) clearTimeout(trailing.current);
    if (now - lastSeekAt.current >= SEEK_THROTTLE_MS) {
      lastSeekAt.current = now;
      onSeek(pos);
    } else {
      // 保证最后一次位置一定会发出
      trailing.current = setTimeout(() => {
        lastSeekAt.current = performance.now();
        onSeek(pos);
      }, SEEK_THROTTLE_MS);
    }
  };

  const commit = () => {
    if (dragPos === null) return;
    if (trailing.current) clearTimeout(trailing.current);
    onSeek(dragPos);
    setDragPos(null);
  };

  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-3">
        {playing ? (
          <Button size="icon" onClick={onPause} aria-label={t("player.pause")}>
            <Pause />
          </Button>
        ) : (
          <Button size="icon" onClick={onPlay} aria-label={t("player.play")}>
            <Play />
          </Button>
        )}
        <Button
          size="icon"
          variant="outline"
          onClick={onStop}
          disabled={status.state === "stopped" && status.posUs === 0}
          aria-label={t("player.stop")}
        >
          <Square />
        </Button>

        <div className="tabular ml-2 w-44 text-sm">
          <span>{formatDurationUs(shown)}</span>
          <span className="text-muted-foreground"> / {formatDurationUs(status.durationUs)}</span>
        </div>

        <div className="ml-auto flex items-center gap-4">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Repeat className="size-4" aria-hidden />
            <Switch
              checked={status.looping}
              onCheckedChange={onLoop}
              aria-label={t("player.loop")}
            />
            {t("player.loop")}
          </label>
          <Select
            value={String(status.speedMilli)}
            onValueChange={(v) => onSpeed(Number(v))}
          >
            <SelectTrigger className="w-24" aria-label={t("player.speed")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SPEED_STEPS.map((s) => (
                <SelectItem key={s} value={String(s)}>
                  {speedLabel(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <input
        type="range"
        className="h-2 w-full cursor-pointer accent-primary"
        min={0}
        max={max}
        step={Math.max(1, Math.round(max / 2000))}
        value={Math.min(shown, max)}
        aria-label={t("player.seekBar")}
        aria-valuetext={`${formatDurationUs(shown)} / ${formatDurationUs(status.durationUs)}`}
        onChange={(e) => {
          const pos = Number(e.target.value);
          setDragPos(pos);
          throttledSeek(pos);
        }}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
    </div>
  );
}

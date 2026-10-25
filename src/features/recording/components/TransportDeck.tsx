import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleStop, ListOrdered, LogOut, Pause, Play, Repeat, Square } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { announce } from "@/shared/stores/announcerStore";
import { Segmented } from "../../../shared/components/Segmented";
import { StatusPill, type StatusTone } from "../../../shared/components/StatusPill";
import { SurfacePanel } from "../../../shared/components/SurfacePanel";
import { TimeCode } from "./console/TimeCode";
import { formatDurationUs } from "../lib/filter";
import {
  SPEED_STEPS,
  nextRepeatMode,
  type PlayState,
  type PlaybackStatus,
  type RepeatMode,
} from "../lib/types";

/** 拖动进度条时向后端发送 seek 的最小间隔（毫秒）。 */
const SEEK_THROTTLE_MS = 60;

const STATE_TONE: Record<PlayState, StatusTone> = {
  playing: "playing",
  paused: "paused",
  stopped: "idle",
};
const STATE_LABEL: Record<PlayState, string> = {
  playing: "player.statePlaying",
  paused: "player.statePaused",
  stopped: "player.stateStopped",
};

interface TransportDeckProps {
  status: PlaybackStatus;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
  onSeek: (posUs: number) => void;
  onSpeed: (milli: number) => void;
  onRepeat: (mode: RepeatMode) => void;
  onExit: () => void;
  /** 是否响应键盘快捷键（回放模式不可见时应关闭，避免空格键被隐藏面板吞掉） */
  hotkeys?: boolean;
}

/** 快捷键跳转步长（微秒）：方向键 5 秒，Shift + 方向键 1 秒。 */
const HOTKEY_SEEK_US = 5_000_000;
const HOTKEY_SEEK_FINE_US = 1_000_000;

/** 焦点在这些元素上时，空格 / 方向键归它们自己处理，不触发全局快捷键。 */
function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.closest(
      'input, textarea, select, button, a[href], [role="slider"], [role="switch"], [role="radio"], [role="combobox"], [role="dialog"]',
    ) !== null
  );
}

/** 重复模式的文案键。 */
const REPEAT_LABEL: Record<RepeatMode, string> = {
  off: "player.repeatOff",
  loop: "player.repeatLoop",
  playlist: "player.repeatPlaylist",
};
const REPEAT_HINT: Record<RepeatMode, string> = {
  off: "player.repeatOffHint",
  loop: "player.repeatLoopHint",
  playlist: "player.repeatPlaylistHint",
};
const REPEAT_ICON: Record<RepeatMode, React.ReactNode> = {
  off: <CircleStop className="size-3.5" aria-hidden />,
  loop: <Repeat className="size-3.5" aria-hidden />,
  playlist: <ListOrdered className="size-3.5" aria-hidden />,
};
const REPEAT_ORDER: RepeatMode[] = ["off", "loop", "playlist"];

/** 倍速显示文案，如 `1x`、`0.5x`。 */
function speedLabel(milli: number): string {
  return `${milli / 1000}x`;
}

/**
 * 传输台：节目名与状态、大号时间码、播放 / 停止 / 重复模式 / 倍速、可拖动的进度滑杆。
 *
 * 拖动期间进度以本地值为准并节流地向后端 seek，松开后回到后端上报的位置。
 */
export function TransportDeck({
  status,
  onPlay,
  onPause,
  onStop,
  onSeek,
  onSpeed,
  onRepeat,
  onExit,
  hotkeys = true,
}: TransportDeckProps) {
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

  // 键盘快捷键：空格 播放 / 暂停，←/→ 前后跳 5 秒（Shift 为 1 秒），L 依次切换重复模式。
  // 用 ref 持有最新状态，监听器只在开关变化时重新注册。
  const live = useRef({ status, playing, onPlay, onPause, onSeek, onRepeat, t });
  useEffect(() => {
    live.current = { status, playing, onPlay, onPause, onSeek, onRepeat, t };
  });
  useEffect(() => {
    if (!hotkeys) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isInteractiveTarget(e.target)) return;
      const cur = live.current;
      if (e.key === " ") {
        e.preventDefault();
        if (cur.playing) cur.onPause();
        else cur.onPlay();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const step = e.shiftKey ? HOTKEY_SEEK_FINE_US : HOTKEY_SEEK_US;
        const delta = e.key === "ArrowLeft" ? -step : step;
        cur.onSeek(Math.min(cur.status.durationUs, Math.max(0, cur.status.posUs + delta)));
      } else if (e.key === "l" || e.key === "L") {
        e.preventDefault();
        // 快捷键切换时焦点没有移动，需主动向读屏播报新模式
        const next = nextRepeatMode(cur.status.repeat);
        cur.onRepeat(next);
        announce(cur.t("player.repeatAnnounce", { mode: cur.t(REPEAT_LABEL[next]) }));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hotkeys]);
  const shown = dragPos ?? status.posUs;
  const max = Math.max(status.durationUs, 1);
  const ratio = Math.min(1, Math.max(0, shown / max));

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
    <SurfacePanel tone={playing ? "playing" : "default"}>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="min-w-0 truncate text-lg font-semibold tracking-tight">{status.name}</h2>
        <StatusPill tone={STATE_TONE[status.state]}>{t(STATE_LABEL[status.state])}</StatusPill>
        <Badge variant="outline">{t("player.liveSuspended")}</Badge>
        <Button variant="outline" size="sm" className="ml-auto" onClick={onExit}>
          <LogOut />
          {t("player.exit")}
        </Button>
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-x-8 gap-y-4">
        <TimeCode valueUs={shown} totalUs={status.durationUs} size="xl" />

        <div className="flex flex-wrap items-center gap-3">
          {playing ? (
            <Button
              size="icon"
              className="size-14 rounded-full glow-primary"
              onClick={onPause}
              aria-label={t("player.pause")}
              aria-keyshortcuts="Space"
              title={`${t("player.pause")} (Space)`}
            >
              <Pause className="size-6 fill-current" />
            </Button>
          ) : (
            <Button
              size="icon"
              className="size-14 rounded-full glow-primary"
              onClick={onPlay}
              aria-label={t("player.play")}
              aria-keyshortcuts="Space"
              title={`${t("player.play")} (Space)`}
            >
              <Play className="size-6 fill-current" />
            </Button>
          )}
          <Button
            size="icon"
            variant="outline"
            className="rounded-full"
            onClick={onStop}
            disabled={status.state === "stopped" && status.posUs === 0}
            aria-label={t("player.stop")}
          >
            <Square />
          </Button>

          <Segmented
            ariaLabel={t("player.repeat")}
            value={status.repeat}
            options={REPEAT_ORDER.map((m) => ({
              value: m,
              label: t(REPEAT_LABEL[m]),
              icon: REPEAT_ICON[m],
              title: t(REPEAT_HINT[m]),
            }))}
            onChange={onRepeat}
            className="ml-2"
          />

          <Segmented
            ariaLabel={t("player.speed")}
            value={String(status.speedMilli)}
            options={SPEED_STEPS.map((s) => ({ value: String(s), label: speedLabel(s) }))}
            onChange={(v) => onSpeed(Number(v))}
          />
        </div>
      </div>

      {/* 进度滑杆：下层 DOM 画轨道与填充，上层原生 range 负责交互与读屏语义 */}
      <div className="relative mt-5 h-6">
        <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-surface-1">
          <div
            className={cn(
              "h-full origin-left rounded-full bg-primary",
              playing && dragPos === null && "transition-transform duration-100 ease-linear",
            )}
            style={{ transform: `scaleX(${ratio})` }}
          />
        </div>
        <input
          type="range"
          className="scrub-range absolute inset-0 size-full"
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
      {hotkeys && (
        <p className="mt-3 text-xs text-muted-foreground">{t("player.hotkeyHint")}</p>
      )}
    </SurfacePanel>
  );
}

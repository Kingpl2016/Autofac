import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleStop, ListOrdered, Pause, Play, Repeat, Square, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { announce } from "@/shared/stores/announcerStore";
import { Segmented } from "@/shared/components/Segmented";
import { StatusPill, type StatusTone } from "@/shared/components/StatusPill";
import { SurfacePanel } from "@/shared/components/SurfacePanel";
import { useWindowKeydown } from "@/shared/hooks/useWindowKeydown";
import { isInteractiveTarget } from "@/shared/lib/keyboard";
import { TimeCode } from "./console/TimeCode";
import { useScrubSeek } from "../hooks/useScrubSeek";
import { formatDurationUs } from "../lib/filter";
import {
  SPEED_STEPS,
  nextRepeatMode,
  type PlayState,
  type PlaybackStatus,
  type RepeatMode,
} from "../lib/types";

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

/** 进度滑块直径（像素），与 `.scrub-range` 的 `--scrub-thumb`（1.125rem）一致。 */
const SCRUB_THUMB_PX = 18;

/** 快捷键跳转步长（微秒）：方向键 5 秒，Shift + 方向键 1 秒。 */
const HOTKEY_SEEK_US = 5_000_000;
const HOTKEY_SEEK_FINE_US = 1_000_000;

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
  const { dragPos, scrub, commit } = useScrubSeek(onSeek);

  const playing = status.state === "playing";

  // 键盘快捷键：空格 播放 / 暂停，←/→ 前后跳 5 秒（Shift 为 1 秒），L 依次切换重复模式。
  useWindowKeydown(
    (e) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isInteractiveTarget(e.target)) return;
      if (e.key === " ") {
        e.preventDefault();
        if (playing) onPause();
        else onPlay();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const step = e.shiftKey ? HOTKEY_SEEK_FINE_US : HOTKEY_SEEK_US;
        const delta = e.key === "ArrowLeft" ? -step : step;
        onSeek(Math.min(status.durationUs, Math.max(0, status.posUs + delta)));
      } else if (e.key === "l" || e.key === "L") {
        e.preventDefault();
        // 快捷键切换时焦点没有移动，需主动向读屏播报新模式
        const next = nextRepeatMode(status.repeat);
        onRepeat(next);
        announce(t("player.repeatAnnounce", { mode: t(REPEAT_LABEL[next]) }));
      }
    },
    { enabled: hotkeys },
  );
  const shown = dragPos ?? status.posUs;
  const max = Math.max(status.durationUs, 1);
  const ratio = Math.min(1, Math.max(0, shown / max));
  const commitDrag = () => commit();

  // 悬停预览：指针在滑杆上时显示该位置对应的时间
  const [hoverRatio, setHoverRatio] = useState<number | null>(null);
  /** 指针位置 → 0~1（按滑块中心的活动范围换算：两端各内缩半个滑块直径）。 */
  const pointerRatio = (e: React.PointerEvent<HTMLInputElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect();
    const inset = SCRUB_THUMB_PX / 2;
    const usable = rect.width - inset * 2;
    if (usable <= 0) return 0;
    return Math.min(1, Math.max(0, (e.clientX - rect.left - inset) / usable));
  };

  return (
    <SurfacePanel tone={playing ? "playing" : "default"}>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="min-w-0 truncate text-lg font-semibold tracking-tight">{status.name}</h2>
        <StatusPill tone={STATE_TONE[status.state]}>{t(STATE_LABEL[status.state])}</StatusPill>
        {/* 关闭节目只卸载节目、不退出播放器模式（退出在页头右侧） */}
        <Button variant="outline" size="sm" className="ml-auto" onClick={onExit}>
          <X />
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

      {/* 进度滑杆：下层 DOM 画轨道、填充与悬停预览，上层原生 range 负责交互与读屏语义。
          轨道两端内缩半个滑块直径（与 `.scrub-range` 的约定一致），填充终点正好落在滑块中心。 */}
      <div className="group/scrub relative mt-6 h-8">
        <div className="absolute inset-x-[0.5625rem] top-1/2 h-2 -translate-y-1/2">
          <div
            className={cn(
              "size-full overflow-hidden rounded-full bg-foreground/15 ring-1 ring-inset ring-foreground/10",
              "transition-transform duration-150 group-hover/scrub:scale-y-125 motion-reduce:transition-none",
            )}
          >
            <div
              className={cn(
                "h-full origin-left rounded-full bg-primary",
                playing && dragPos === null && "transition-transform duration-100 ease-linear motion-reduce:transition-none",
              )}
              style={{ transform: `scaleX(${ratio})` }}
            />
          </div>
          {hoverRatio !== null && (
            <>
              {/* 悬停位置的细线与时间气泡（纯视觉提示，读屏用滑杆自己的 valuetext） */}
              <span
                className="pointer-events-none absolute top-1/2 h-3.5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/60"
                style={{ left: `${hoverRatio * 100}%` }}
                aria-hidden
              />
              <span
                className="num pointer-events-none absolute bottom-full mb-3 -translate-x-1/2 rounded-md border border-border bg-popover px-2 py-0.5 text-xs font-medium text-popover-foreground shadow-md"
                style={{ left: `${hoverRatio * 100}%` }}
                aria-hidden
              >
                {formatDurationUs(hoverRatio * status.durationUs)}
              </span>
            </>
          )}
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
          onChange={(e) => scrub(Number(e.target.value))}
          onPointerMove={(e) => setHoverRatio(pointerRatio(e))}
          onPointerLeave={() => setHoverRatio(null)}
          onPointerUp={commitDrag}
          onKeyUp={commitDrag}
          onBlur={commitDrag}
        />
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {hotkeys ? <p>{t("player.hotkeyHint")}</p> : <span />}
        <span className="num">{t("player.remaining", { time: formatDurationUs(Math.max(0, status.durationUs - shown)) })}</span>
      </div>
    </SurfacePanel>
  );
}

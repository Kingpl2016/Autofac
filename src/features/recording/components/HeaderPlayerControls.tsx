import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { Pause, Play, Square } from "lucide-react";
import { toast } from "sonner";

import { errorMessage } from "@/shared/lib/errors";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";
import { useScrubSeek } from "../hooks/useScrubSeek";
import { playerPause, playerPlay, playerSeek, playerStop } from "../lib/api";
import { formatDurationUs } from "../lib/filter";
import { xToTimeUs } from "../lib/overview";
import { PLAYER_ERR_NO_PLAYER } from "../lib/types";
import { usePlayerStore } from "../stores/usePlayerStore";

/** 键盘方向键的跳转步长（微秒）：5 秒，Shift 为 1 秒（与传输台快捷键一致）。 */
const KEY_STEP_US = 5_000_000;
const KEY_STEP_FINE_US = 1_000_000;

/**
 * 顶栏迷你传输条：播放器模式下在任何页面都能播放 / 暂停 / 停止并拖动跳转。
 *
 * 只在播放器模式且已打开节目时出现；状态来自 `player:state`（与回放面板共用 store），
 * 拖动期间进度以本地位置为准（`useScrubSeek`）。
 */
export function HeaderPlayerControls() {
  const { t } = useTranslation();
  const playerMode = useEngineStatusStore((s) => s.appMode === "player");
  const status = usePlayerStore((s) => s.status);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const run = (action: () => Promise<void>) => {
    void action().catch((e: unknown) => {
      const raw = errorMessage(e);
      toast.error(raw === PLAYER_ERR_NO_PLAYER ? t("player.errNoPlayer") : raw);
    });
  };
  const { dragPos, scrub, commit, cancel } = useScrubSeek((pos) => run(() => playerSeek(pos)));

  if (!playerMode || !status.loaded) return null;

  const playing = status.state === "playing";
  const duration = status.durationUs;
  const shown = dragPos ?? status.posUs;
  const ratio = duration > 0 ? Math.min(1, Math.max(0, shown / duration)) : 0;

  const posAt = (clientX: number): number => {
    const el = trackRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return xToTimeUs(clientX - rect.left, rect.width, duration);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? KEY_STEP_FINE_US : KEY_STEP_US;
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = status.posUs + step;
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = status.posUs - step;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = duration;
    if (next === null) return;
    e.preventDefault();
    run(() => playerSeek(Math.min(duration, Math.max(0, next))));
  };

  return (
    <div className="flex min-w-0 items-center gap-1.5" role="group" aria-label={t("header.playerControls")}>
      <Button
        size="icon"
        className="size-8 rounded-full"
        aria-label={playing ? t("player.pause") : t("player.play")}
        title={playing ? t("player.pause") : t("player.play")}
        onClick={() => run(playing ? playerPause : playerPlay)}
      >
        {playing ? <Pause className="fill-current" /> : <Play className="fill-current" />}
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="size-8"
        aria-label={t("player.stop")}
        title={t("player.stop")}
        disabled={status.state === "stopped" && status.posUs === 0}
        onClick={() => run(playerStop)}
      >
        <Square />
      </Button>

      <span className="num ml-1.5 text-xs text-foreground/80" aria-hidden>
        {formatDurationUs(shown)}
      </span>
      <div
        role="slider"
        tabIndex={0}
        aria-label={t("header.playerSeek")}
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-valuenow={Math.min(shown, duration)}
        aria-valuetext={`${formatDurationUs(shown)} / ${formatDurationUs(duration)}`}
        /* 左右各留 0.625rem：滑块在 0% / 100% 时半个圆点会伸出轨道，留白保证它不贴到两侧的时间 */
        className="group flex h-8 w-28 cursor-pointer touch-none items-center rounded-md px-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:w-44"
        onKeyDown={onKeyDown}
        onPointerDown={(e) => {
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          scrub(posAt(e.clientX));
        }}
        onPointerMove={(e) => {
          if (dragging.current) scrub(posAt(e.clientX));
        }}
        onPointerUp={(e) => {
          if (!dragging.current) return;
          dragging.current = false;
          commit(posAt(e.clientX));
        }}
        onPointerCancel={() => {
          dragging.current = false;
          cancel();
        }}
      >
        {/* 实际轨道（位置换算以它为准）。播放器模式下顶栏带一层主色底，`bg-muted` 会和底色融在一起：
            轨道用前景色半透明 + 内描边，未播放部分在深浅主题下都看得清 */}
        <div ref={trackRef} className="relative flex h-full w-full items-center">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/20 ring-1 ring-inset ring-foreground/10">
            <div
              className={cn(
                "h-full origin-left rounded-full bg-primary",
                playing && dragPos === null && "transition-transform duration-100 ease-linear motion-reduce:transition-none",
              )}
              style={{ transform: `scaleX(${ratio})` }}
            />
          </div>
          <span
            className="pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-primary-foreground shadow-[0_0_0_2px_var(--card)] transition-transform group-hover:scale-110 motion-reduce:transition-none"
            style={{ left: `${ratio * 100}%` }}
            aria-hidden
          />
        </div>
      </div>
      <span className="num text-xs text-foreground/80" aria-hidden>
        {formatDurationUs(duration)}
      </span>
      <span
        className="ml-1 hidden max-w-40 truncate text-xs font-medium 2xl:inline"
        title={status.name}
      >
        {status.name}
      </span>
    </div>
  );
}

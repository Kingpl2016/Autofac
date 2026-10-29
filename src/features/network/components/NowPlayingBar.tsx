import { Pause, Play, Square } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { DeviceAccess } from "../hooks/useDeviceAccess";
import { useDeviceFiles } from "../hooks/useDeviceFiles";
import { usePlayer } from "../hooks/useDeviceStatus";
import { netdevProgramOp, netdevSpeed } from "../lib/api";
import { formatClock } from "../lib/format";
import { netKeys } from "../lib/queryKeys";
import { useNetCommand } from "../hooks/useNetCommand";
import { PlayState, ProgramAction, type NetDevice } from "../lib/types";
import { SpeedMenu } from "./SpeedMenu";

interface NowPlayingBarProps {
  device: NetDevice;
  access: DeviceAccess;
}

/**
 * “正在播放”条：设备播放或暂停时出现在设备头下方，切到任何 Tab 都能暂停 / 停止 / 改倍速。
 * 是否显示看状态轮询里的播放摘要；显示时才按 1 秒轮询播放器取精确进度。
 */
export function NowPlayingBar({ device, access }: NowPlayingBarProps) {
  const { t } = useTranslation();
  // 无论成败都以设备实际状态为准：结束后刷新播放器与状态
  const command = useNetCommand<() => Promise<unknown>>({
    run: (fn) => fn(),
    invalidate: [netKeys.player(device.id), netKeys.status(device.id)],
  });
  const brief = access.status.status?.player;
  const active = access.canRead && (brief?.state === PlayState.Playing || brief?.state === PlayState.Paused);
  const player = usePlayer(device.id, active);
  const { files } = useDeviceFiles(device.id, active);

  if (!active || !brief) return null;

  const state = player?.state ?? brief.state;
  if (state !== PlayState.Playing && state !== PlayState.Paused) return null;
  const paused = state === PlayState.Paused;
  const programNo = player?.programNo ?? brief.programNo;
  const pos = player?.posMs ?? brief.posMs;
  const dur = player?.durMs ?? brief.durMs;
  const ratio = dur > 0 ? Math.min(1, pos / dur) : 0;
  const fileName = files.find((f) => f.program === programNo)?.name;
  const disabled = !access.canWrite || command.pending;
  const act = (fn: () => Promise<unknown>) => command.run(fn);

  return (
    <section
      aria-label={t("network.nowPlaying.title")}
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border px-4 py-2.5 animate-fade-up",
        paused ? "border-warning/40 bg-warning/5" : "border-success/35 bg-success/5",
      )}
    >
      <span className={cn("inline-flex shrink-0 items-center gap-1.5 text-sm font-semibold", paused ? "text-warning" : "text-success")}>
        {paused ? <Pause className="size-3.5 fill-current" aria-hidden /> : <Play className="size-3.5 fill-current" aria-hidden />}
        {paused ? t("network.files.paused") : t("network.nowPlaying.title")}
      </span>
      <span className="min-w-0 max-w-[40%] truncate text-sm font-medium" title={fileName}>
        <span className="tabular mr-1.5 text-muted-foreground">#{programNo}</span>
        {fileName ?? t("network.player.programNo", { no: programNo })}
      </span>
      <span
        role="progressbar"
        aria-label={t("network.player.seekBar")}
        aria-valuemin={0}
        aria-valuemax={Math.max(dur, 1)}
        aria-valuenow={Math.min(pos, Math.max(dur, 1))}
        aria-valuetext={`${formatClock(pos)} / ${formatClock(dur)}`}
        className="h-1.5 min-w-24 flex-1 overflow-hidden rounded-full bg-surface-1"
      >
        <span
          className={cn(
            "block h-full origin-left rounded-full transition-transform duration-300 ease-linear motion-reduce:transition-none",
            paused ? "bg-warning" : "bg-success",
          )}
          style={{ transform: `scaleX(${ratio})` }}
        />
      </span>
      <span className="tabular shrink-0 text-xs text-muted-foreground">
        {formatClock(pos)} / {formatClock(dur)}
      </span>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          variant="outline"
          size="icon"
          className="size-9"
          disabled={disabled}
          aria-label={paused ? t("network.player.resume") : t("network.player.pause")}
          onClick={() => void act(() => netdevProgramOp(device.id, programNo, ProgramAction.Pause))}
        >
          {paused ? <Play /> : <Pause />}
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="size-9"
          disabled={disabled}
          aria-label={t("network.player.stop")}
          onClick={() => void act(() => netdevProgramOp(device.id, programNo, ProgramAction.Stop))}
        >
          <Square />
        </Button>
        {player && (
          <SpeedMenu value={player.speedX100} disabled={disabled} onChange={(v) => void act(() => netdevSpeed(device.id, v))} />
        )}
      </div>
    </section>
  );
}

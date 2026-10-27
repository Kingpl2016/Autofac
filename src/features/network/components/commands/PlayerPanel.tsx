import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pause, Play, Repeat, Square } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusPill, type StatusTone } from "@/shared/components/StatusPill";
import { SurfacePanel } from "@/shared/components/SurfacePanel";
import { useDeviceFiles } from "../../hooks/useDeviceFiles";
import type { DeviceAccess } from "../../hooks/useDeviceAccess";
import { usePlayer } from "../../hooks/useDeviceStatus";
import { netdevProgramOp, netdevSeek, netdevSpeed } from "../../lib/api";
import { formatCount } from "@/shared/lib/format";
import { formatClock } from "../../lib/format";
import { netKeys } from "../../lib/queryKeys";
import { runCommand } from "../../lib/run";
import { PlayState, ProgramAction, type NetDevice } from "../../lib/types";
import { SpeedMenu } from "../SpeedMenu";

const TONE: Record<number, StatusTone> = {
  [PlayState.Idle]: "idle",
  [PlayState.Stopped]: "idle",
  [PlayState.Playing]: "playing",
  [PlayState.Paused]: "paused",
};

interface PlayerPanelProps {
  device: NetDevice;
  access: DeviceAccess;
}

/**
 * 播放器：状态、时间码、可拖动的进度条、倍速与基本控制。
 * 进度条拖动时只更新本地显示，松手（指针抬起 / 键盘抬起 / 失焦）才提交 seek。
 */
export function PlayerPanel({ device, access }: PlayerPanelProps) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const player = usePlayer(device.id, access.canRead);
  const { files } = useDeviceFiles(device.id, access.canRead);
  const [dragPos, setDragPos] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const state = player?.state ?? PlayState.Idle;
  const playing = state === PlayState.Playing;
  const paused = state === PlayState.Paused;
  const loaded = (player?.programNo ?? 0) > 0 && state !== PlayState.Idle;
  const fileName = files.find((f) => f.program === player?.programNo)?.name;
  const dur = player?.durMs ?? 0;
  const shown = dragPos ?? player?.posMs ?? 0;
  const ratio = dur > 0 ? Math.min(1, shown / dur) : 0;
  const disabled = !access.canWrite || busy;

  const refresh = () => client.invalidateQueries({ queryKey: netKeys.player(device.id) });

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    await runCommand(t, fn);
    await refresh();
    setBusy(false);
  };

  const program = player?.programNo ?? 0;
  const commit = () => {
    if (dragPos === null) return;
    const pos = dragPos;
    setDragPos(null);
    void act(() => netdevSeek(device.id, pos));
  };

  return (
    <SurfacePanel
      title={t("network.player.title")}
      tone={playing ? "playing" : "default"}
      actions={
        <>
          {player && loaded && (
            <Badge variant="secondary">
              <Repeat className="size-3" aria-hidden />
              {t(`network.player.repeat.${player.repeat}`, { defaultValue: t("network.player.repeat.0") })}
            </Badge>
          )}
          <StatusPill tone={TONE[state] ?? "idle"}>{t(`network.player.state.${state}`)}</StatusPill>
        </>
      }
    >
      {!player ? (
        <p className="text-sm text-muted-foreground">{t("network.player.unavailable")}</p>
      ) : (
        <div className="grid gap-4">
          <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
            <p className="min-w-0 truncate text-base font-medium">
              {loaded ? (
                <>
                  <span className="tabular mr-2 text-muted-foreground">#{program}</span>
                  {fileName ?? t("network.player.programNo", { no: program })}
                </>
              ) : (
                <span className="text-muted-foreground">{t("network.player.none")}</span>
              )}
            </p>
            <p className="num text-2xl font-semibold tracking-tight">
              {formatClock(shown)}
              <span className="text-base font-normal text-muted-foreground"> / {formatClock(dur)}</span>
            </p>
          </div>

          {/* 下层 DOM 画轨道与填充，上层原生 range 负责交互与读屏语义 */}
          {/* 轨道两端内缩半个滑块直径（与 `.scrub-range` 一致），填充终点落在滑块中心 */}
          <div className="relative h-8">
            <div className="absolute inset-x-[0.5625rem] top-1/2 h-2 -translate-y-1/2 overflow-hidden rounded-full bg-foreground/15 ring-1 ring-inset ring-foreground/10">
              <div
                className="h-full origin-left rounded-full bg-primary transition-transform duration-100 ease-linear"
                style={{ transform: `scaleX(${ratio})` }}
              />
            </div>
            <input
              type="range"
              className="scrub-range absolute inset-0 size-full"
              min={0}
              max={Math.max(dur, 1)}
              step={Math.max(1, Math.round(dur / 1000))}
              value={Math.min(shown, Math.max(dur, 1))}
              disabled={disabled || !loaded}
              aria-label={t("network.player.seekBar")}
              aria-valuetext={`${formatClock(shown)} / ${formatClock(dur)}`}
              onChange={(e) => setDragPos(Number(e.target.value))}
              onPointerUp={commit}
              onKeyUp={commit}
              onBlur={commit}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || !loaded}
              onClick={() => void act(() => netdevProgramOp(device.id, program, ProgramAction.Stop))}
            >
              <Square />
              {t("network.player.stop")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || !loaded}
              onClick={() => void act(() => netdevProgramOp(device.id, program, ProgramAction.Pause))}
            >
              {paused ? <Play /> : <Pause />}
              {paused ? t("network.player.resume") : t("network.player.pause")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || program === 0}
              onClick={() => void act(() => netdevProgramOp(device.id, program, ProgramAction.PlayOnce))}
            >
              <Play />
              {t("network.player.playOnce")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || program === 0}
              onClick={() => void act(() => netdevProgramOp(device.id, program, ProgramAction.PlayLoop))}
            >
              <Repeat />
              {t("network.player.playLoop")}
            </Button>

            <SpeedMenu
              className="ml-auto h-10 gap-1.5 px-3"
              value={player.speedX100}
              disabled={disabled}
              onChange={(v) => void act(() => netdevSpeed(device.id, v))}
            />
          </div>

          <dl className="grid grid-cols-3 gap-4 border-t border-border pt-3 text-xs">
            <Metric label={t("network.player.universes")} value={formatCount(player.universes)} />
            <Metric label={t("network.player.frames")} value={formatCount(player.frames)} />
            <Metric
              label={t("network.player.badFrames")}
              value={formatCount(player.badFrames)}
              warn={player.badFrames > 0}
              warnText={t("network.player.badFramesWarn")}
            />
          </dl>
        </div>
      )}
    </SurfacePanel>
  );
}

function Metric({
  label,
  value,
  warn,
  warnText,
}: {
  label: string;
  value: string;
  warn?: boolean;
  warnText?: string;
}) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={warn ? "tabular mt-0.5 text-sm font-medium text-warning" : "tabular mt-0.5 text-sm font-medium"}>
        {value}
        {warn && warnText ? <span className="ml-1.5 text-xs font-normal">{warnText}</span> : null}
      </dd>
    </div>
  );
}

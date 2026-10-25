import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Film, LogOut } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useSettingsQuery } from "@/features/settings";
import { ChannelGrid, UniversePicker } from "@/features/universes";
import { isTauri } from "@/shared/tauri/invoke";
import { ChannelCurves } from "./ChannelCurves";
import { PlayerTargetPicker } from "./PlayerTargetPicker";
import { TimelineHeatmap } from "./TimelineHeatmap";
import { TransportBar } from "./TransportBar";
import { usePlayerStore } from "../hooks/usePlayerStore";
import {
  playerClose,
  playerPause,
  playerPlay,
  playerSeek,
  playerSetLoop,
  playerSetSpeed,
  playerSetTarget,
  playerSetViewed,
  playerStop,
} from "../lib/api";
import {
  PLAYER_ERR_BAD_TARGET,
  PLAYER_ERR_NO_PLAYER,
  type PlayerTarget,
} from "../lib/types";

/** 同时显示的 Universe 数超过此值给出性能提示。 */
const PERF_WARN_THRESHOLD = 16;

interface PlayerPanelProps {
  /** 跳转到节目库标签页（未打开节目时的引导） */
  onGoLibrary: () => void;
}

/** 把任意异常规整为字符串。 */
function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 回放面板：传输条、输出目标、被查看 Universe 的 512 通道栅格。
 *
 * 状态完全来自后端 `player:state` 事件；本面板只发命令，不在本地推算播放位置。
 */
export function PlayerPanel({ onGoLibrary }: PlayerPanelProps) {
  const { t } = useTranslation();
  const status = usePlayerStore((s) => s.status);
  const channels = usePlayerStore((s) => s.channels);
  const settings = useSettingsQuery();
  const valueFormat = settings.data?.display.valueFormat ?? "decimal";
  // 用户的选择与所属节目绑定；换节目后自动回落到"默认查看第一路 Universe"，避免打开后一片空白
  const [selection, setSelection] = useState<{ path: string; list: number[] } | null>(null);
  const viewed =
    selection && selection.path === status.path
      ? selection.list
      : status.universes.slice(0, 1);
  const setViewed = (list: number[]) => setSelection({ path: status.path, list });

  // 同步到后端，决定推送哪些通道数据
  useEffect(() => {
    if (!isTauri() || !status.loaded) return;
    void playerSetViewed(viewed).catch(() => {});
  }, [viewed, status.loaded]);

  const run = useCallback(
    async (action: () => Promise<void>) => {
      try {
        await action();
      } catch (e: unknown) {
        const raw = messageOf(e);
        if (raw === PLAYER_ERR_NO_PLAYER) toast.error(t("player.errNoPlayer"));
        else if (raw === PLAYER_ERR_BAD_TARGET) toast.error(t("player.errBadTarget"));
        else toast.error(raw);
      }
    },
    [t],
  );

  const toggle = (u: number) =>
    setViewed(
      viewed.includes(u)
        ? viewed.filter((x) => x !== u)
        : [...viewed, u].sort((a, b) => a - b),
    );

  const stateBadge = useMemo(() => {
    switch (status.state) {
      case "playing":
        return <Badge variant="success">{t("player.statePlaying")}</Badge>;
      case "paused":
        return <Badge variant="warning">{t("player.statePaused")}</Badge>;
      default:
        return <Badge variant="secondary">{t("player.stateStopped")}</Badge>;
    }
  }, [status.state, t]);

  if (!status.loaded) {
    return (
      <div className="flex h-56 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border text-sm text-muted-foreground">
        <Film className="size-8 opacity-50" aria-hidden />
        <p>{t("player.empty")}</p>
        <Button variant="outline" size="sm" onClick={onGoLibrary}>
          {t("player.goLibrary")}
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-(--density-gutter)">
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-3">
            <span className="truncate">{status.name}</span>
            {stateBadge}
            <Badge variant="outline">{t("player.liveSuspended")}</Badge>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              onClick={() => void run(playerClose)}
            >
              <LogOut />
              {t("player.exit")}
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-5">
          <TransportBar
            status={status}
            onPlay={() => void run(playerPlay)}
            onPause={() => void run(playerPause)}
            onStop={() => void run(playerStop)}
            onSeek={(pos) => void run(() => playerSeek(pos))}
            onSpeed={(m) => void run(() => playerSetSpeed(m))}
            onLoop={(l) => void run(() => playerSetLoop(l))}
          />
          {status.corruptFrames > 0 && (
            <p className="text-xs text-warning">
              {t("player.corruptWarn", { n: status.corruptFrames })}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("player.timelineCard")}</CardTitle>
        </CardHeader>
        <CardContent>
          <TimelineHeatmap
            path={status.path}
            durationUs={status.durationUs}
            posUs={status.posUs}
            viewed={viewed}
            onSeek={(pos) => void run(() => playerSeek(pos))}
            onToggleUniverse={toggle}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("player.curvesCard")}</CardTitle>
        </CardHeader>
        <CardContent>
          <ChannelCurves
            path={status.path}
            durationUs={status.durationUs}
            posUs={status.posUs}
            universes={status.universes}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("player.outputCard")}</CardTitle>
        </CardHeader>
        <CardContent>
          <PlayerTargetPicker
            key={JSON.stringify(status.target)}
            target={status.target}
            destinations={status.destinations}
            onApply={(target: PlayerTarget) => void run(() => playerSetTarget(target))}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("player.channelsCard")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <UniversePicker
            available={status.universes}
            selected={viewed}
            onToggle={toggle}
            onSelectAll={(all) => setViewed([...all])}
            onClear={() => setViewed([])}
          />
          {viewed.length >= PERF_WARN_THRESHOLD && (
            <p className="text-xs text-warning">{t("universes.perfWarning")}</p>
          )}
          {viewed.length === 0 ? (
            <div className="flex h-32 items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
              {t("universes.noSelection")}
            </div>
          ) : (
            <div className="grid gap-(--density-gutter) xl:grid-cols-2">
              {viewed.map((u) => (
                <ChannelGrid
                  key={u}
                  universe={u}
                  valueFormat={valueFormat}
                  data={channels[u] ?? EMPTY_CHANNELS}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** 尚未收到该 Universe 数据时的占位（全 0）。 */
const EMPTY_CHANNELS: number[] = [];

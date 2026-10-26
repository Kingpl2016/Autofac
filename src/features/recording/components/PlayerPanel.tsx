import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Film, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useSettingsQuery } from "@/features/settings";
import { ChannelGrid, UniversePicker } from "@/features/universes";
import { SurfacePanel } from "../../../shared/components/SurfacePanel";
import { ChannelCurves } from "./ChannelCurves";
import { PlayerTargetPicker } from "./PlayerTargetPicker";
import { TimelineHeatmap } from "./TimelineHeatmap";
import { TransportDeck } from "./TransportDeck";
import { usePlayerStore } from "../stores/usePlayerStore";
import {
  playerClose,
  playerPause,
  playerPlay,
  playerSeek,
  playerSetRepeat,
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
  /** 跳转到节目库（未打开节目时的引导） */
  onGoLibrary: () => void;
  /** 面板当前是否可见；不可见时不响应键盘快捷键（默认可见） */
  active?: boolean;
}

/** 把任意异常规整为字符串。 */
function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 回放面板：传输台、时间线、通道曲线、输出目标与被查看 Universe 的 512 通道栅格。
 *
 * 状态完全来自后端 `player:state` 事件；本面板只发命令，不在本地推算播放位置。
 */
export function PlayerPanel({ onGoLibrary, active = true }: PlayerPanelProps) {
  const { t } = useTranslation();
  const status = usePlayerStore((s) => s.status);
  const channels = usePlayerStore((s) => s.channels);
  const settings = useSettingsQuery();
  const valueFormat = settings.data?.display.valueFormat ?? "decimal";
  const [channelsOpen, setChannelsOpen] = useState(true);
  // 用户的选择与所属节目绑定；换节目后自动回落到"默认查看第一路 Universe"，避免打开后一片空白
  const [selection, setSelection] = useState<{ path: string; list: number[] } | null>(null);
  const viewed =
    selection && selection.path === status.path
      ? selection.list
      : status.universes.slice(0, 1);
  const setViewed = (list: number[]) => setSelection({ path: status.path, list });

  // 同步到后端，决定推送哪些通道数据
  useEffect(() => {
    if (!status.loaded) return;
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

  if (!status.loaded) {
    return (
      <div className="flex min-h-72 flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border bg-surface-1 px-6 text-center">
        <span className="flex size-14 items-center justify-center rounded-full bg-surface-3 text-muted-foreground">
          <Film className="size-7" aria-hidden />
        </span>
        <p className="max-w-sm text-sm text-muted-foreground">{t("player.empty")}</p>
        <Button variant="outline" onClick={onGoLibrary}>
          {t("player.goLibrary")}
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-(--density-gap)">
      <TransportDeck
        status={status}
        onPlay={() => void run(playerPlay)}
        onPause={() => void run(playerPause)}
        onStop={() => void run(playerStop)}
        onSeek={(pos) => void run(() => playerSeek(pos))}
        onSpeed={(m) => void run(() => playerSetSpeed(m))}
        onRepeat={(m) => void run(() => playerSetRepeat(m))}
        onExit={() => void run(playerClose)}
        hotkeys={active}
      />
      {status.corruptFrames > 0 && (
        <p className="flex items-start gap-2 rounded-lg bg-warning/10 px-4 py-2.5 text-xs text-warning">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t("player.corruptWarn", { n: status.corruptFrames })}
        </p>
      )}

      <SurfacePanel title={t("player.timelineCard")}>
        <TimelineHeatmap
          path={status.path}
          durationUs={status.durationUs}
          posUs={status.posUs}
          viewed={viewed}
          onSeek={(pos) => void run(() => playerSeek(pos))}
          onToggleUniverse={toggle}
        />
      </SurfacePanel>

      <div className="grid items-start gap-(--density-gap) 2xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <SurfacePanel title={t("player.curvesCard")}>
          <ChannelCurves
            path={status.path}
            durationUs={status.durationUs}
            posUs={status.posUs}
            universes={status.universes}
          />
        </SurfacePanel>

        <SurfacePanel title={t("player.outputCard")}>
          <PlayerTargetPicker
            key={JSON.stringify(status.target)}
            target={status.target}
            destinations={status.destinations}
            onApply={(target: PlayerTarget) => void run(() => playerSetTarget(target))}
          />
        </SurfacePanel>
      </div>

      <SurfacePanel
        title={t("player.channelsCard")}
        actions={
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={channelsOpen}
            onClick={() => setChannelsOpen((o) => !o)}
          >
            <ChevronDown
              className={cn("transition-transform", !channelsOpen && "-rotate-90")}
              aria-hidden
            />
            {channelsOpen ? t("player.collapse") : t("player.expand")}
          </Button>
        }
      >
        {channelsOpen && (
          <div className="grid gap-4">
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
          </div>
        )}
      </SurfacePanel>
    </div>
  );
}

/** 尚未收到该 Universe 数据时的占位（全 0）。 */
const EMPTY_CHANNELS = new Uint8Array(0);

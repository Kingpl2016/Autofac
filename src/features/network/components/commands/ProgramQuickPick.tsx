import { useMemo, useState } from "react";
import { Play, Repeat } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { ConfirmDialog } from "@/shared/components/ConfirmDialog";
import { Segmented } from "@/shared/components/Segmented";
import { SurfacePanel } from "@/shared/components/SurfacePanel";
import type { DeviceAccess } from "../../hooks/useDeviceAccess";
import { useDeviceFiles } from "../../hooks/useDeviceFiles";
import { useFileActions } from "../../hooks/useFileActions";
import { activeProgramNo, isPlayableMode, sortFiles } from "../../lib/files";
import type { NetDevice } from "../../lib/types";

interface ProgramQuickPickProps {
  device: NetDevice;
  access: DeviceAccess;
}

/**
 * 节目快选：设备上已编号的文件排成网格（#号 + 文件名），点一下就播放。
 *
 * 播放方式（单次 / 循环）在标题旁切换；当前工作模式不允许播放时会先确认是否切到节目模式。
 * 按编号删除文件不在这里提供：删除在“文件”Tab 里进行，能看清删的是哪个文件。
 */
export function ProgramQuickPick({ device, access }: ProgramQuickPickProps) {
  const { t } = useTranslation();
  const { files, isLoading, refresh } = useDeviceFiles(device.id, access.canRead);
  const status = access.status.status;
  const workMode = status?.workMode ?? null;
  const playingNo = activeProgramNo(status?.player ?? null);
  const actions = useFileActions({ device, workMode, files, refresh, playingNo });
  const [mode, setMode] = useState<"once" | "loop">("once");
  const numbered = useMemo(() => sortFiles(files).filter((f) => f.program !== null), [files]);
  const loop = mode === "loop";

  return (
    <SurfacePanel
      title={t("network.quick.title")}
      actions={
        <Segmented
          ariaLabel={t("network.quick.modeLabel")}
          value={mode}
          onChange={setMode}
          options={[
            { value: "once", label: t("network.player.playOnce"), icon: <Play className="size-3.5" aria-hidden /> },
            { value: "loop", label: t("network.player.playLoop"), icon: <Repeat className="size-3.5" aria-hidden /> },
          ]}
        />
      }
    >
      {workMode !== null && !isPlayableMode(workMode) && (
        <p className="mb-3 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
          {t("network.quick.modeHint", { mode: t(`network.modes.${workMode}`) })}
        </p>
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
      ) : numbered.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("network.quick.empty")}</p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {numbered.map((f) => {
            const current = f.program === playingNo;
            return (
              <li key={f.name}>
                <button
                  type="button"
                  disabled={!access.canWrite}
                  aria-label={`${loop ? t("network.player.playLoop") : t("network.player.playOnce")}: ${f.name}`}
                  onClick={() => actions.requestPlay(f, loop)}
                  className={cn(
                    "group flex w-full cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors duration-150 motion-reduce:transition-none",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    "disabled:cursor-not-allowed disabled:opacity-60",
                    current ? "border-success/40 bg-success/10" : "border-border hover:border-ring/50 hover:bg-surface-3/60",
                  )}
                >
                  <span className="tabular w-10 shrink-0 text-sm font-semibold text-muted-foreground">#{f.program}</span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium" title={f.name}>
                    {f.name}
                  </span>
                  {current ? (
                    <span className="shrink-0 text-xs font-medium text-success">{t("network.files.playing")}</span>
                  ) : loop ? (
                    <Repeat className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden />
                  ) : (
                    <Play className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={actions.pendingPlay !== null}
        onOpenChange={(o) => !o && actions.cancelPlay()}
        title={t("network.files.switchModeTitle")}
        description={t("network.files.switchModeDesc", {
          mode: actions.pendingPlay ? t(`network.modes.${actions.pendingPlay.mode}`) : "",
        })}
        confirmLabel={t("network.files.switchAndPlay")}
        onConfirm={actions.confirmPlay}
      />
    </SurfacePanel>
  );
}

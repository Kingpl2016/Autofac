import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pause, Play, Repeat, Square, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDialog } from "@/shared/components/ConfirmDialog";
import { SurfacePanel } from "@/shared/components/SurfacePanel";
import type { DeviceAccess } from "../../hooks/useDeviceAccess";
import { netdevProgramOp } from "../../lib/api";
import { isPlayableMode } from "../../lib/files";
import { netKeys } from "../../lib/queryKeys";
import { runCommand } from "../../lib/run";
import { ProgramAction, type NetDevice } from "../../lib/types";

interface ProgramPanelProps {
  device: NetDevice;
  access: DeviceAccess;
}

/**
 * 节目操作：按节目号下发停止 / 暂停 / 单次 / 循环 / 删除。
 *
 * 固件规则：播放类操作只在"自动"和"节目"模式允许；删除不受模式限制，
 * 且会**删除设备上的节目文件**，所以走破坏性确认。录制动作固件不支持，不提供。
 */
export function ProgramPanel({ device, access }: ProgramPanelProps) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [raw, setRaw] = useState("1");
  const [touched, setTouched] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const no = Number(raw);
  const valid = Number.isInteger(no) && no >= 1 && no <= 255;
  const mode = access.status.status?.workMode ?? null;
  const playable = mode === null || isPlayableMode(mode);
  const write = access.canWrite && valid;

  const send = async (action: number, ok?: string) => {
    const done = await runCommand(t, () => netdevProgramOp(device.id, no, action), ok);
    if (done) {
      void client.invalidateQueries({ queryKey: netKeys.player(device.id) });
      void client.invalidateQueries({ queryKey: netKeys.status(device.id) });
      void client.invalidateQueries({ queryKey: netKeys.files(device.id) });
    }
  };

  return (
    <SurfacePanel title={t("network.program.title")}>
      <div className="grid gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="net-program-no">{t("network.program.no")}</Label>
          <Input
            id="net-program-no"
            className="tabular w-28"
            inputMode="numeric"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            onBlur={() => setTouched(true)}
            aria-invalid={touched && !valid ? true : undefined}
            aria-describedby="net-program-no-hint"
          />
          <p
            id="net-program-no-hint"
            role={touched && !valid ? "alert" : undefined}
            className={touched && !valid ? "text-xs font-medium text-destructive" : "text-xs text-muted-foreground"}
          >
            {touched && !valid ? t("network.program.noInvalid") : t("network.program.noHint")}
          </p>
        </div>

        {!playable && (
          <p className="rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
            {t("network.program.modeBlocked", { mode: t(`network.modes.${mode ?? 0}`) })}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={!write || !playable} onClick={() => void send(ProgramAction.Stop)}>
            <Square />
            {t("network.player.stop")}
          </Button>
          <Button size="sm" variant="outline" disabled={!write || !playable} onClick={() => void send(ProgramAction.Pause)}>
            <Pause />
            {t("network.player.pause")}
          </Button>
          <Button size="sm" variant="outline" disabled={!write || !playable} onClick={() => void send(ProgramAction.PlayOnce)}>
            <Play />
            {t("network.player.playOnce")}
          </Button>
          <Button size="sm" variant="outline" disabled={!write || !playable} onClick={() => void send(ProgramAction.PlayLoop)}>
            <Repeat />
            {t("network.player.playLoop")}
          </Button>
          <span className="mx-1 hidden w-px self-stretch bg-border sm:block" aria-hidden />
          <Button
            size="sm"
            variant="outline"
            className="text-destructive hover:text-destructive"
            disabled={!write}
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 />
            {t("network.program.deleteFile")}
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t("network.program.deleteTitle", { no })}
        description={t("network.program.deleteDesc")}
        confirmLabel={t("common.delete")}
        destructive
        onConfirm={() => void send(ProgramAction.Delete, t("network.program.deleted", { no }))}
      />
    </SurfacePanel>
  );
}

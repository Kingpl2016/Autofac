import { useRef } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useEngineDataStore } from "@/shared/stores/engineDataStore";
import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";
import { useModeActions } from "../hooks/useModeActions";
import { useModeDialogStore } from "../stores/useModeDialogStore";

/**
 * 模式切换确认对话框：在布局里挂载一次，任何入口都通过 `useModeActions().requestMode` 打开。
 *
 * - 进入播放器模式：正文写出具体后果（当前接收多少个 Universe、将被清空），
 *   录制中则说明会先停止并保存，主按钮改为“停止录制并进入”。这不是销毁数据，所以用主色而不是红色。
 * - 退出播放器模式：仅在正在播放时出现，说明会停止输出并关闭节目。
 *
 * 默认聚焦“取消”（防误触），`Esc` 取消，焦点由对话框自动还给触发它的控件。
 */
export function ModeConfirmDialog() {
  const { t } = useTranslation();
  const request = useModeDialogStore((s) => s.request);
  const close = useModeDialogStore((s) => s.close);
  const { confirm } = useModeActions();
  const recording = useEngineStatusStore((s) => s.recording);
  const packetRate = useEngineStatusStore((s) => s.packetRate);
  const universes = useEngineDataStore((s) => s.universes.length);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const entering = request?.target === "player";

  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          cancelRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {entering ? t("mode.confirmEnterTitle") : t("mode.confirmLeaveTitle")}
          </DialogTitle>
          <DialogDescription>
            {entering ? t("mode.confirmEnterDesc") : t("mode.confirmLeaveDesc")}
          </DialogDescription>
        </DialogHeader>

        {entering && (
          <ul className="grid gap-1.5 text-sm text-muted-foreground">
            {universes > 0 && (
              <li>
                {t("mode.confirmEnterLive", { universes, rate: packetRate })}
              </li>
            )}
            {recording && <li className="text-foreground">{t("mode.confirmEnterRecording")}</li>}
          </ul>
        )}

        <DialogFooter>
          <Button ref={cancelRef} variant="outline" onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button onClick={confirm}>
            {entering
              ? recording
                ? t("mode.confirmEnterStopAction")
                : t("mode.confirmEnterAction")
              : t("mode.confirmLeaveAction")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

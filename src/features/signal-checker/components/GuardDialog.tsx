import { useRef } from "react";
import type { TFunction } from "i18next";
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
import type { StartReason } from "../lib/guard";

interface GuardDialogProps {
  /** 待确认的原因；`null` 表示不显示 */
  reasons: StartReason[] | null;
  /** `start`：开始发送前确认；`switch`：发送中切换到闪烁图案前确认 */
  variant: "start" | "switch";
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 发送前确认：把"为什么要确认"逐条写出来，让用户知道测试信号会真实影响现场。
 *
 * 默认聚焦“取消”（防止连按回车误确认）；Esc 等同取消。
 */
export function GuardDialog({ reasons, variant, onConfirm, onCancel }: GuardDialogProps) {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <Dialog open={reasons !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          cancelRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {variant === "start"
              ? t("signalChecker.confirmStartTitle")
              : t("signalChecker.confirmSwitchTitle")}
          </DialogTitle>
          <DialogDescription>{t("signalChecker.confirmDesc")}</DialogDescription>
        </DialogHeader>
        <ul className="grid list-disc gap-2 pl-5 text-sm">
          {reasons?.map((reason) => (
            <li key={reason.kind}>{describeReason(reason, t)}</li>
          ))}
        </ul>
        <DialogFooter>
          <Button ref={cancelRef} variant="outline" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button onClick={onConfirm}>
            {variant === "start" ? t("signalChecker.confirmStart") : t("signalChecker.confirmSwitch")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 把一个确认原因说成一句话。 */
function describeReason(reason: StartReason, t: TFunction): string {
  switch (reason.kind) {
    case "remote":
      return t("signalChecker.reasonRemote", { ip: reason.ip });
    case "forwarding":
      return t("signalChecker.reasonForwarding", { count: reason.count });
    case "strobe":
      return t("signalChecker.reasonStrobe");
  }
}

import { useState } from "react";
import { ChevronDown, RotateCw, ShieldAlert, Stethoscope } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDialog } from "@/shared/components/ConfirmDialog";
import { SurfacePanel } from "@/shared/components/SurfacePanel";
import type { DeviceAccess } from "../../hooks/useDeviceAccess";
import { netdevBoardOp } from "../../lib/api";
import { runCommand } from "../../lib/run";
import type { NetDevice } from "../../lib/types";

/** 设备操作码。 */
const OP = { Reset: 0, Factory: 1, SelfTest: 2 } as const;

interface BoardOpsPanelProps {
  device: NetDevice;
  access: DeviceAccess;
}

/**
 * 设备操作：自检、复位、恢复出厂。
 *
 * 复位和恢复出厂会重启设备，所以都要确认；恢复出厂更危险，需要输入设备名确认，
 * 并且在空间上与其它按钮分开。执行后进入"重启中"，页面自动等待设备回来。
 */
export function BoardOpsPanel({ device, access }: BoardOpsPanelProps) {
  const { t } = useTranslation();
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmFactory, setConfirmFactory] = useState(false);

  const reboot = async (op: number, ok: string) => {
    const done = await runCommand(t, () => netdevBoardOp(device.id, op), ok);
    if (done) access.markRebooting();
  };

  return (
    <SurfacePanel title={t("network.board.title")}>
      <div className="grid gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!access.canWrite}
            onClick={() => void runCommand(t, () => netdevBoardOp(device.id, OP.SelfTest), t("network.board.selfTestDone"))}
          >
            <Stethoscope />
            {t("network.board.selfTest")}
          </Button>
          <Button size="sm" variant="outline" disabled={!access.canWrite} onClick={() => setConfirmReset(true)}>
            <RotateCw />
            {t("network.board.reset")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("network.board.hint")}</p>

        {/* 危险区默认折叠：不可逆的操作不和日常操作摆在一起 */}
        <Collapsible className="mt-1 rounded-lg border border-destructive/40 bg-destructive/5">
          <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <ShieldAlert className="size-4 shrink-0" aria-hidden />
            <span className="flex-1">{t("network.board.dangerZone")}</span>
            <ChevronDown
              className="size-4 transition-transform group-data-[state=closed]:-rotate-90 motion-reduce:transition-none"
              aria-hidden
            />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-destructive/30 px-3 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{t("network.board.factory")}</p>
                <p className="text-xs text-muted-foreground">{t("network.board.factoryHint")}</p>
              </div>
              <Button size="sm" variant="destructive" disabled={!access.canWrite} onClick={() => setConfirmFactory(true)}>
                <ShieldAlert />
                {t("network.board.factory")}
              </Button>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>

      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title={t("network.board.resetTitle", { name: device.name })}
        description={t("network.board.resetDesc")}
        confirmLabel={t("network.board.reset")}
        onConfirm={() => void reboot(OP.Reset, t("network.board.resetSent"))}
      />

      <FactoryResetDialog
        open={confirmFactory}
        onOpenChange={setConfirmFactory}
        deviceName={device.name}
        onConfirm={() => void reboot(OP.Factory, t("network.board.factorySent"))}
      />
    </SurfacePanel>
  );
}

interface FactoryResetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deviceName: string;
  onConfirm: () => void;
}

/** 恢复出厂确认：必须输入设备名才能启用确认按钮。每次打开都是全新实例。 */
function FactoryResetDialog({ open, onOpenChange, deviceName, onConfirm }: FactoryResetDialogProps) {
  if (!open) return null;
  return <FactoryResetForm onOpenChange={onOpenChange} deviceName={deviceName} onConfirm={onConfirm} />;
}

function FactoryResetForm({ onOpenChange, deviceName, onConfirm }: Omit<FactoryResetDialogProps, "open">) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState("");
  const matches = typed.trim() === deviceName;
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("network.board.factoryTitle", { name: deviceName })}</DialogTitle>
          <DialogDescription>{t("network.board.factoryDesc")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="net-factory-confirm">{t("network.board.factoryType", { name: deviceName })}</Label>
          <Input
            id="net-factory-confirm"
            value={typed}
            autoComplete="off"
            onChange={(e) => setTyped(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="destructive"
            disabled={!matches}
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            {t("network.board.factory")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

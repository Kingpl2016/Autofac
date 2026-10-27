import { Skeleton } from "@/components/ui/skeleton";
import { useState } from "react";
import { RotateCw, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/shared/components/ConfirmDialog";
import { SurfacePanel } from "@/shared/components/SurfacePanel";
import type { DeviceAccess } from "../../hooks/useDeviceAccess";
import { useDeviceConfig } from "../../hooks/useDeviceConfig";
import { netdevBoardOp } from "../../lib/api";
import { errorText } from "../../lib/errors";
import { runCommand } from "../../lib/run";
import type { NetDevice } from "../../lib/types";
import { ConfigForm, GROUP_ANCHOR } from "./ConfigForm";
import { TokenCard } from "./TokenCard";

interface ConfigPanelProps {
  device: NetDevice;
  access: DeviceAccess;
  /** 是否有未保存的更改（变化时上报，用于 Tab 上的提示点） */
  onDirtyChange?: (dirty: boolean) => void;
}

/**
 * 配置：分组表单（网络 / 输出 / 转发）加访问 Token。
 *
 * - 只提交改动过的字段；校验规则与固件一致。
 * - 网络字段（DHCP / 地址 / 主机名）改动后需重启生效：保存后显示横幅和"立即重启"。
 */
export function ConfigPanel({ device, access, onDirtyChange }: ConfigPanelProps) {
  const { t } = useTranslation();
  const { config, isLoading, error, save, refetch } = useDeviceConfig(device.id, access.canRead);
  const [rebootNeeded, setRebootNeeded] = useState(false);
  const [confirmReboot, setConfirmReboot] = useState(false);

  if (isLoading) {
    return <Skeleton aria-busy="true" className="h-64 rounded-xl bg-surface-2" />;
  }
  if (error || !config) {
    return (
      <SurfacePanel title={t("network.config.title")}>
        <p className="text-sm text-muted-foreground">
          {error ? errorText(t, error) : t("network.config.unavailable")}
        </p>
        <Button className="mt-3" size="sm" variant="outline" onClick={refetch}>
          {t("network.access.retry")}
        </Button>
      </SurfacePanel>
    );
  }

  const reboot = async () => {
    const ok = await runCommand(t, () => netdevBoardOp(device.id, 0), t("network.board.resetSent"));
    if (ok) {
      access.markRebooting();
      setRebootNeeded(false);
    }
  };

  return (
    <div className="grid gap-(--density-gutter)">
      {rebootNeeded && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-warning"
        >
          <TriangleAlert className="size-4 shrink-0" aria-hidden />
          <p className="min-w-0 flex-1 text-sm font-medium">{t("network.config.rebootBanner")}</p>
          <Button size="sm" disabled={!access.canWrite} onClick={() => setConfirmReboot(true)}>
            <RotateCw />
            {t("network.config.rebootNow")}
          </Button>
        </div>
      )}

      <ConfigForm
        // 配置刷新后重建表单，草稿回到设备的真实值
        key={JSON.stringify(config)}
        access={access}
        config={config}
        save={save}
        onSaved={(needsReboot) => needsReboot && setRebootNeeded(true)}
        onDirtyChange={onDirtyChange}
        after={
          <div id={`${GROUP_ANCHOR}security`} className="scroll-mt-16">
            <TokenCard device={device} access={access} tokenSet={config.tokenSet} />
          </div>
        }
      />

      <ConfirmDialog
        open={confirmReboot}
        onOpenChange={setConfirmReboot}
        title={t("network.board.resetTitle", { name: device.name })}
        description={t("network.board.resetDesc")}
        confirmLabel={t("network.board.reset")}
        onConfirm={() => void reboot()}
      />
    </div>
  );
}

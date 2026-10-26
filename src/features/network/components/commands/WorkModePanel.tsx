import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Segmented } from "@/shared/components/Segmented";
import { SurfacePanel } from "@/shared/components/SurfacePanel";
import { netdevSetWorkmode } from "../../lib/api";
import { netKeys } from "../../lib/queryKeys";
import { runCommand } from "../../lib/run";
import { WORK_MODES, type NetDevice } from "../../lib/types";
import type { DeviceAccess } from "../../hooks/useDeviceAccess";

interface WorkModePanelProps {
  device: NetDevice;
  access: DeviceAccess;
}

/**
 * 工作模式：6 选 1。方向键只移动焦点，Enter / Space 才应用（切换有副作用：会启停转发和回放）。
 * 显示值始终来自设备状态，应用失败时自然回到设备的真实模式。
 */
export function WorkModePanel({ device, access }: WorkModePanelProps) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const current = access.status.status?.workMode ?? null;

  const apply = async (value: string) => {
    const mode = Number(value);
    if (mode === current) return;
    setBusy(true);
    await runCommand(
      t,
      () => netdevSetWorkmode(device.id, mode),
      t("network.control.modeApplied", { mode: t(`network.modes.${mode}`) }),
    );
    // 无论成败都以设备实际状态为准
    await client.invalidateQueries({ queryKey: netKeys.status(device.id) });
    setBusy(false);
  };

  return (
    <SurfacePanel title={t("network.control.modeTitle")}>
      <Segmented
        ariaLabel={t("network.control.modeTitle")}
        activation="manual"
        size="md"
        busy={busy || !access.canWrite}
        value={current === null ? "" : String(current)}
        options={WORK_MODES.map((m) => ({ value: String(m), label: t(`network.modes.${m}`) }))}
        onChange={(v) => void apply(v)}
        className="flex-wrap"
      />
      <p className="mt-3 text-xs text-muted-foreground" aria-live="polite">
        {current === null ? t("network.control.modeUnknown") : t(`network.modeDesc.${current}`)}
      </p>
    </SurfacePanel>
  );
}

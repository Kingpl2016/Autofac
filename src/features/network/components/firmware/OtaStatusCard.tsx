import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { SurfacePanel } from "@/shared/components/SurfacePanel";
import type { DeviceAccess } from "../../hooks/useDeviceAccess";
import { netdevOtaConfirm, netdevOtaStatus } from "../../lib/api";
import { errorText } from "../../lib/errors";
import { netKeys } from "../../lib/queryKeys";
import { runCommand } from "../../lib/run";
import type { NetDevice } from "../../lib/types";

interface OtaStatusCardProps {
  device: NetDevice;
  access: DeviceAccess;
}

/**
 * 当前设备的 OTA 状态：运行分区、固件版本、编译时间、回滚保护。
 * 新固件"待确认"时给出手动确认按钮（固件自检通过后也会自动确认）。
 */
export function OtaStatusCard({ device, access }: OtaStatusCardProps) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: netKeys.ota(device.id),
    queryFn: () => netdevOtaStatus(device.id),
    enabled: access.canRead,
    retry: false,
  });
  const ota = query.data;

  const confirm = async () => {
    const ok = await runCommand(t, () => netdevOtaConfirm(device.id), t("network.fw.confirmed"));
    if (ok) await client.invalidateQueries({ queryKey: netKeys.ota(device.id) });
  };

  return (
    <SurfacePanel title={t("network.fw.currentTitle")}>
      {query.isLoading ? (
        <div aria-busy="true" className="h-16 animate-pulse rounded bg-surface-1 motion-reduce:animate-none" />
      ) : !ota ? (
        <p className="text-sm text-muted-foreground">{query.error ? errorText(t, query.error) : t("network.fw.unavailable")}</p>
      ) : (
        <div className="grid gap-4">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
            <Item label={t("network.fw.version")} value={ota.version} />
            <Item label={t("network.fw.partition")} value={ota.running} />
            <Item label={t("network.fw.compileTime")} value={ota.compileTime} />
            <Item
              label={t("network.fw.rollback")}
              value={ota.rollbackEnabled ? t("network.fw.rollbackOn") : t("network.fw.rollbackOff")}
            />
          </dl>
          {ota.pendingVerify ? (
            <div role="status" className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-warning">
              <TriangleAlert className="size-4 shrink-0" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{t("network.fw.pendingTitle")}</p>
                <p className="text-xs">{t("network.fw.pendingBody")}</p>
              </div>
              <Button size="sm" disabled={!access.canWrite} onClick={() => void confirm()}>
                <ShieldCheck />
                {t("network.fw.confirmNow")}
              </Button>
            </div>
          ) : (
            <p className="inline-flex items-center gap-1.5 text-xs text-success">
              <ShieldCheck className="size-3.5" aria-hidden />
              {t("network.fw.verified")}
            </p>
          )}
        </div>
      )}
    </SurfacePanel>
  );
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="tabular mt-0.5 truncate text-sm font-medium" title={value}>
        {value || "—"}
      </dd>
    </div>
  );
}

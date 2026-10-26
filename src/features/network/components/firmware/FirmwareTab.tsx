import { useQueries } from "@tanstack/react-query";
import { useState } from "react";
import { FileCog, FolderOpen, Rocket } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/shared/components/ConfirmDialog";
import { SurfacePanel } from "@/shared/components/SurfacePanel";
import { pickFirmwareFile } from "@/shared/tauri/pickers";
import { cn } from "@/lib/utils";
import type { DeviceAccess } from "../../hooks/useDeviceAccess";
import { netdevInspectFirmware, netdevStatus } from "../../lib/api";
import { errorText, toNetError } from "../../lib/errors";
import { formatBytes } from "../../lib/format";
import { netKeys, STATUS_POLL_MS } from "../../lib/queryKeys";
import type { DeviceStatus, NetDevice } from "../../lib/types";
import { compareVersion } from "../../lib/upgrade";
import { useUpgradeStore } from "../../stores/useUpgradeStore";
import { OtaStatusCard } from "./OtaStatusCard";
import { Stepper } from "./Stepper";
import { UpgradeProgress } from "./UpgradeProgress";

interface FirmwareTabProps {
  /** 当前设备（默认勾选） */
  device: NetDevice;
  /** 全部已保存设备（批量升级的候选） */
  devices: NetDevice[];
  access: DeviceAccess;
}

/**
 * 固件升级：选择固件并预检 → 选择目标设备（可多选）→ 确认 → 顺序升级并显示每台进度。
 *
 * 升级流程由全局 store 驱动，切换 Tab / 页面不会中断，回来时进度还在。
 */
export function FirmwareTab({ device, devices, access }: FirmwareTabProps) {
  const { t } = useTranslation();
  const { stage, firmware, targets, stopRequested, setFirmware, start, requestStop, reset } = useUpgradeStore();
  const [selection, setSelection] = useState<string[]>([device.id]);
  const [inspecting, setInspecting] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const results = useQueries({
    queries: devices.map((d) => ({
      queryKey: netKeys.status(d.id),
      queryFn: () => netdevStatus(d.id),
      retry: false,
      refetchInterval: STATUS_POLL_MS,
    })),
  });
  const statusById = new Map<string, { status: DeviceStatus | null; code: string | null }>(
    devices.map((d, i) => [
      d.id,
      { status: results[i]?.data ?? null, code: results[i]?.isError ? toNetError(results[i].error).code : null },
    ]),
  );

  const choose = async () => {
    const picked = await pickFirmwareFile();
    if (!picked) return;
    setInspecting(true);
    setInspectError(null);
    try {
      setFirmware(await netdevInspectFirmware(picked), picked);
    } catch (e) {
      setFirmware(null, null);
      setInspectError(errorText(t, e));
    } finally {
      setInspecting(false);
    }
  };

  const eligible = (id: string) => statusById.get(id)?.status != null;
  const chosen = selection.filter(eligible);
  const running = stage === "running";
  const step = !firmware ? 0 : stage === "idle" ? (chosen.length > 0 ? 2 : 1) : stage === "running" ? 2 : 4;

  const toggle = (id: string, on: boolean) =>
    setSelection((s) => (on ? [...s.filter((x) => x !== id), id] : s.filter((x) => x !== id)));

  const begin = () => {
    const inputs = devices
      .filter((d) => chosen.includes(d.id))
      .map((d) => ({ id: d.id, name: d.name, fromVersion: statusById.get(d.id)?.status?.version ?? null }));
    void start(inputs).catch((e) => toast.error(errorText(t, e)));
  };

  const chosenNames = devices.filter((d) => chosen.includes(d.id)).map((d) => d.name);

  return (
    <div className="grid gap-(--density-gutter)">
      <OtaStatusCard device={device} access={access} />

      <SurfacePanel title={t("network.fw.upgradeTitle")}>
        <Stepper
          label={t("network.fw.steps")}
          current={step}
          steps={[t("network.fw.step1"), t("network.fw.step2"), t("network.fw.step3"), t("network.fw.step4")]}
        />
      </SurfacePanel>

      {stage === "idle" || !firmware ? (
        <>
          <SurfacePanel
            title={t("network.fw.pickTitle")}
            actions={
              <Button size="sm" variant="outline" onClick={() => void choose()} disabled={inspecting}>
                <FolderOpen />
                {firmware ? t("network.fw.pickAgain") : t("network.fw.pick")}
              </Button>
            }
          >
            {inspectError ? (
              <p role="alert" className="text-sm text-destructive">
                {inspectError}
              </p>
            ) : firmware ? (
              <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 xl:grid-cols-6">
                <Meta label={t("network.fw.file")} value={firmware.fileName} />
                <Meta label={t("network.fw.version")} value={firmware.version} />
                <Meta label={t("network.fw.project")} value={firmware.projectName} />
                <Meta label={t("network.fw.buildDate")} value={`${firmware.buildDate} ${firmware.buildTime}`} />
                <Meta label={t("network.fw.idf")} value={firmware.idfVersion} />
                <Meta label={t("network.fw.size")} value={formatBytes(firmware.size)} />
              </dl>
            ) : (
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <FileCog className="size-5 shrink-0" aria-hidden />
                {inspecting ? t("network.fw.inspecting") : t("network.fw.pickHint")}
              </div>
            )}
          </SurfacePanel>

          {firmware && (
            <SurfacePanel
              title={t("network.fw.targetsTitle")}
              actions={<span className="text-xs text-muted-foreground">{t("network.fw.selected", { count: chosen.length })}</span>}
            >
              {devices.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("network.noDevice")}</p>
              ) : (
                <ul className="divide-y divide-border">
                  {devices.map((d) => {
                    const info = statusById.get(d.id);
                    const ok = eligible(d.id);
                    const relation = info?.status ? compareVersion(firmware.version, info.status.version) : "unknown";
                    return (
                      <li key={d.id} className={cn("flex items-center gap-3 py-2.5", !ok && "opacity-60")}>
                        <input
                          id={`fw-target-${d.id}`}
                          type="checkbox"
                          className="size-4 accent-primary"
                          checked={selection.includes(d.id) && ok}
                          disabled={!ok}
                          onChange={(e) => toggle(d.id, e.target.checked)}
                        />
                        <label htmlFor={`fw-target-${d.id}`} className="min-w-0 flex-1 cursor-pointer">
                          <span className="block truncate text-sm font-medium">{d.name}</span>
                          <span className="tabular block text-xs text-muted-foreground">
                            {d.host}
                            {info?.status ? ` · v${info.status.version}` : ""}
                          </span>
                        </label>
                        <span
                          className={cn(
                            "text-xs font-medium",
                            !ok && "text-muted-foreground",
                            ok && relation === "newer" && "text-success",
                            ok && relation === "same" && "text-warning",
                            ok && relation === "older" && "text-warning",
                          )}
                        >
                          {!ok
                            ? info?.code === "unauthorized"
                              ? t("network.rail.needToken")
                              : t("network.rail.offline")
                            : t(`network.fw.relation.${relation}`)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </SurfacePanel>
          )}

          {firmware && (
            <div className="flex items-center justify-end gap-3">
              <p className="mr-auto text-xs text-muted-foreground">{t("network.fw.warn")}</p>
              <Button disabled={chosen.length === 0 || running} onClick={() => setConfirming(true)}>
                <Rocket />
                {t("network.fw.start", { count: chosen.length })}
              </Button>
            </div>
          )}
        </>
      ) : (
        <UpgradeProgress stage={stage} targets={targets} stopRequested={stopRequested} onStop={requestStop} onReset={reset} />
      )}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("network.fw.confirmTitle", { count: chosen.length })}
        description={t("network.fw.confirmDesc", { names: chosenNames.join("、"), version: firmware?.version ?? "" })}
        confirmLabel={t("network.fw.confirmStart")}
        destructive
        onConfirm={begin}
      />
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="tabular mt-0.5 truncate text-sm font-medium" title={value}>
        {value || "—"}
      </dd>
    </div>
  );
}

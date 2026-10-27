import { useQueries } from "@tanstack/react-query";
import { useState } from "react";
import { ArrowDown, ArrowUp, Equal, FileCog, FolderOpen, HelpCircle, Rocket } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { compareVersion, type VersionRelation } from "../../lib/upgrade";
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

type Relation = VersionRelation;

/** 版本关系徽章：图标 + 文字，降级用告警色，相同用中性色。 */
const RELATION_BADGE: Record<Relation, { variant: "success" | "secondary" | "warning"; icon: typeof ArrowUp }> = {
  newer: { variant: "success", icon: ArrowUp },
  same: { variant: "secondary", icon: Equal },
  older: { variant: "warning", icon: ArrowDown },
  unknown: { variant: "secondary", icon: HelpCircle },
};

/**
 * 固件：当前固件状态 + 一张升级卡片（标题下是步骤条：选择固件 → 选择设备 → 确认并升级 → 完成）。
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
  // 失败后 react-query 仍保留上次的数据：只有最近一次请求成功的设备才可升级
  const statusById = new Map<string, { status: DeviceStatus | null; ok: boolean; code: string | null }>(
    devices.map((d, i) => [
      d.id,
      {
        status: results[i]?.data ?? null,
        ok: results[i]?.isSuccess === true,
        code: results[i]?.isError ? toNetError(results[i].error).code : null,
      },
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

  const eligible = (id: string) => {
    const info = statusById.get(id);
    return info?.ok === true && info.status != null;
  };
  const chosen = selection.filter(eligible);
  const running = stage === "running";
  const step = !firmware ? 0 : stage === "idle" ? (chosen.length > 0 ? 2 : 1) : stage === "running" ? 2 : 4;
  const upgradable = firmware
    ? devices.filter((d) => eligible(d.id) && compareVersion(firmware.version, statusById.get(d.id)?.status?.version ?? "") === "newer")
    : [];

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

      {stage === "idle" || !firmware ? (
        <SurfacePanel title={t("network.fw.upgradeTitle")}>
          <Stepper
            label={t("network.fw.steps")}
            current={step}
            steps={[t("network.fw.step1"), t("network.fw.step2"), t("network.fw.step3"), t("network.fw.step4")]}
          />

          {/* 第 1 步：固件文件 */}
          <section aria-label={t("network.fw.pickTitle")} className="mt-5 border-t border-border pt-4">
            <header className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-medium">{t("network.fw.pickTitle")}</h3>
              <Button size="sm" variant="outline" className="h-9 px-3" onClick={() => void choose()} disabled={inspecting} loading={inspecting}>
                <FolderOpen />
                {firmware ? t("network.fw.pickAgain") : t("network.fw.pick")}
              </Button>
            </header>
            {inspectError ? (
              <p role="alert" className="text-sm text-destructive">
                {inspectError}
              </p>
            ) : firmware ? (
              <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 2xl:grid-cols-6">
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
          </section>

          {/* 第 2 步：目标设备 */}
          {firmware && (
            <section aria-label={t("network.fw.targetsTitle")} className="mt-5 border-t border-border pt-4">
              <header className="mb-2 flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-sm font-medium">{t("network.fw.targetsTitle")}</h3>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground">{t("network.fw.selected", { count: chosen.length })}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 px-3"
                    disabled={upgradable.length === 0}
                    onClick={() => setSelection(upgradable.map((d) => d.id))}
                  >
                    {t("network.fw.selectUpgradable", { count: upgradable.length })}
                  </Button>
                </div>
              </header>
              {devices.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("network.noDevice")}</p>
              ) : (
                <ul className="divide-y divide-border">
                  {devices.map((d) => {
                    const info = statusById.get(d.id);
                    const ok = eligible(d.id);
                    const relation: Relation = info?.status ? compareVersion(firmware.version, info.status.version) : "unknown";
                    const badge = RELATION_BADGE[relation];
                    const BadgeIcon = badge.icon;
                    return (
                      <li key={d.id} className={cn("flex items-center gap-3 py-2.5", !ok && "opacity-60")}>
                        <Checkbox
                          id={`fw-target-${d.id}`}
                          checked={selection.includes(d.id) && ok}
                          disabled={!ok}
                          onCheckedChange={(v) => toggle(d.id, v === true)}
                        />
                        <label htmlFor={`fw-target-${d.id}`} className="min-w-0 flex-1 cursor-pointer">
                          <span className="block truncate text-sm font-medium">{d.name}</span>
                          <span className="tabular block text-xs text-muted-foreground">
                            {d.host}
                            {info?.status ? ` · v${info.status.version}` : ""}
                          </span>
                        </label>
                        {ok ? (
                          <Badge variant={badge.variant}>
                            <BadgeIcon className="size-3" aria-hidden />
                            {t(`network.fw.relation.${relation}`)}
                          </Badge>
                        ) : (
                          <span className="text-xs font-medium text-muted-foreground">
                            {info?.code === "unauthorized" ? t("network.rail.needToken") : t("network.rail.offline")}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}

              <div className="mt-4 flex flex-wrap items-center justify-end gap-3 border-t border-border pt-4">
                <p className="mr-auto text-xs text-muted-foreground">{t("network.fw.warn")}</p>
                <Button disabled={chosen.length === 0 || running} onClick={() => setConfirming(true)}>
                  <Rocket />
                  {t("network.fw.start", { count: chosen.length })}
                </Button>
              </div>
            </section>
          )}
        </SurfacePanel>
      ) : (
        <UpgradeProgress stage={stage} targets={targets} stopRequested={stopRequested} onStop={requestStop} onReset={reset} />
      )}

      {/* 升级不是破坏性操作（失败会回滚），确认按钮用主色；红色留给删除 / 恢复出厂 */}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("network.fw.confirmTitle", { count: chosen.length })}
        description={t("network.fw.confirmDesc", { names: chosenNames.join("、"), version: firmware?.version ?? "" })}
        confirmLabel={t("network.fw.confirmStart")}
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

import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { formatBytes } from "../lib/format";
import type { DeviceStatus } from "../lib/types";
import type { LinkState } from "../lib/access";
import { DeviceStatusBadge } from "./DeviceStatusBadge";

interface DeviceSummaryProps {
  deviceName: string;
  status: DeviceStatus | null;
  link: LinkState;
}

/** SD 剩余低于该比例时告警。 */
const LOW_SPACE_RATIO = 0.1;

/**
 * 当前设备的摘要条：链路、IP、工作模式、固件版本、SD 容量。
 * 离线时保留最后已知值并整体灰化。
 */
export function DeviceSummary({ deviceName, status, link }: DeviceSummaryProps) {
  const { t } = useTranslation();
  const stale = link !== "online";
  const total = status?.sdTotal ?? 0;
  const free = status?.sdFree ?? 0;
  const freeRatio = total > 0 ? free / total : 1;
  const low = status?.sdMounted === true && total > 0 && freeRatio < LOW_SPACE_RATIO;
  const usedPct = total > 0 ? Math.round(((total - free) / total) * 100) : 0;

  return (
    <section
      aria-label={deviceName}
      className={cn(
        "mb-(--density-gutter) rounded-xl border border-border bg-surface-2 p-(--panel-pad) panel-edge",
        stale && "opacity-70",
      )}
    >
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1">
        <h2 className="truncate text-base font-semibold tracking-tight">{deviceName}</h2>
        <DeviceStatusBadge state={link} />
        {stale && status && (
          <span className="text-xs text-muted-foreground">{t("network.summary.stale")}</span>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 xl:grid-cols-5">
        <Stat label={t("network.summary.link")}>
          {status ? (status.linkUp ? t("network.summary.linkUp") : t("network.summary.linkDown")) : "—"}
        </Stat>
        <Stat label={t("network.summary.ip")}>
          {status ? (
            <>
              <span className="tabular">{status.ip}</span>
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                {status.viaDhcp ? t("network.summary.dhcp") : t("network.summary.staticIp")}
              </span>
            </>
          ) : (
            "—"
          )}
        </Stat>
        <Stat label={t("network.summary.mode")}>
          {status ? `${status.workMode} · ${t(`network.modes.${status.workMode}`)}` : "—"}
        </Stat>
        <Stat label={t("network.summary.version")}>
          <span className="tabular">{status?.version || "—"}</span>
        </Stat>
        <Stat label={t("network.summary.sd")}>
          {status === null ? (
            "—"
          ) : status.sdMounted && total > 0 ? (
            <>
              <span
                role="progressbar"
                aria-label={t("network.summary.sd")}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={usedPct}
                className="mb-1.5 block h-1.5 w-full overflow-hidden rounded-full bg-surface-1"
              >
                <span
                  className={cn("block h-full rounded-full", low ? "bg-warning" : "bg-primary")}
                  style={{ width: `${usedPct}%` }}
                />
              </span>
              <span className={cn("tabular text-xs font-normal", low ? "text-warning" : "text-muted-foreground")}>
                {t("network.summary.sdFree", { free: formatBytes(free), total: formatBytes(total) })}
                {low ? ` · ${t("network.summary.sdLow")}` : ""}
              </span>
            </>
          ) : (
            t("network.summary.sdMissing")
          )}
        </Stat>
      </dl>
    </section>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-medium">{children}</dd>
    </div>
  );
}

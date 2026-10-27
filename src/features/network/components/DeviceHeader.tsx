import type { ReactNode } from "react";
import { useIsFetching, useQuery, useQueryClient } from "@tanstack/react-query";
import { HardDrive, Network as NetworkIcon, Pencil, RefreshCw, ShieldCheck, SlidersHorizontal, TriangleAlert, Cpu } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { DeviceAccess } from "../hooks/useDeviceAccess";
import type { LinkState } from "../lib/access";
import { netdevOtaStatus } from "../lib/api";
import { isPlayableMode } from "../lib/files";
import { formatBytes, formatHourMinute } from "../lib/format";
import { netKeys } from "../lib/queryKeys";
import type { NetDevice } from "../lib/types";
import { AgoText } from "./AgoText";
import { DeviceStatusBadge } from "./DeviceStatusBadge";

/** SD 剩余低于该比例时告警。 */
const LOW_SPACE_RATIO = 0.1;

interface DeviceHeaderProps {
  device: NetDevice;
  access: DeviceAccess;
  link: LinkState;
  /** 标题左侧的额外内容（窄屏下的设备切换按钮） */
  leading?: ReactNode;
  onEdit: () => void;
}

/**
 * 当前设备的头部：吸顶的标题行（名称 · 状态 · 地址 · 更新时间 · 刷新 / 编辑），
 * 下面是 4 张等宽的关键指标卡：网络、工作模式、固件、SD 卡。
 *
 * 设备不在线时保留最后已知值，数值降为弱化色并注明“数据来自 HH:mm”；状态文字本身保持完整对比度。
 */
export function DeviceHeader({ device, access, link, leading, onEdit }: DeviceHeaderProps) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const status = access.status.status;
  const updatedAt = access.status.updatedAt ?? null;
  const stale = link !== "online";
  const fetching = useIsFetching({ queryKey: netKeys.status(device.id) }) > 0;

  const ota = useQuery({
    queryKey: netKeys.ota(device.id),
    queryFn: () => netdevOtaStatus(device.id),
    enabled: access.canRead,
    retry: false,
  }).data;

  const refresh = () => {
    for (const key of [netKeys.status, netKeys.player, netKeys.files, netKeys.ota, netKeys.config]) {
      void client.invalidateQueries({ queryKey: key(device.id) });
    }
  };

  const total = status?.sdTotal ?? 0;
  const free = status?.sdFree ?? 0;
  const low = status?.sdMounted === true && total > 0 && free / total < LOW_SPACE_RATIO;
  const usedPct = total > 0 ? Math.round(((total - free) / total) * 100) : 0;
  const valueTone = stale ? "text-muted-foreground" : "text-foreground";

  // 标题行与指标卡是两个兄弟节点：吸顶元素只在父元素范围内吸附，标题行必须直接挂在整个滚动内容的容器下
  return (
    <>
      <div className="sticky top-0 z-20 -mx-1 -mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 bg-background/95 px-1 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        {leading}
        <h2 className="min-w-0 truncate text-lg font-semibold tracking-tight">{device.name}</h2>
        <span
          className={cn(
            "inline-flex items-center rounded-full px-2.5 py-0.5",
            link === "online" && "bg-success/15",
            (link === "needToken" || link === "rebooting") && "bg-warning/15",
            (link === "offline" || link === "checking") && "bg-secondary",
          )}
        >
          <DeviceStatusBadge state={link} />
        </span>
        <span className="tabular min-w-0 truncate text-xs text-muted-foreground">
          {device.host}
          {device.port !== 80 ? `:${device.port}` : ""}
          {updatedAt !== null && (
            <>
              {" · "}
              {stale ? (
                t("network.header.staleSince", { time: formatHourMinute(updatedAt) })
              ) : (
                <>
                  {t("network.header.updated")} <AgoText ts={updatedAt} intervalMs={5000} />
                </>
              )}
            </>
          )}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="outline" size="sm" className="h-9 px-3" onClick={refresh} disabled={fetching}>
            <RefreshCw className={cn(fetching && "animate-spin motion-reduce:animate-none")} />
            {t("network.files.refresh")}
          </Button>
          <Button variant="outline" size="sm" className="h-9 px-3" onClick={onEdit}>
            <Pencil />
            {t("common.edit")}
          </Button>
        </div>
      </div>

      <section aria-label={device.name} className="@container">
        <dl className="grid grid-cols-1 gap-3 @md:grid-cols-2 @4xl:grid-cols-4">
          <Kpi icon={<NetworkIcon aria-hidden />} label={t("network.summary.ip")}>
            {status ? (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={0} className={cn("tabular cursor-help rounded-sm text-base font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring", valueTone)}>
                      {status.ip}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="tabular">
                    {t("network.config.fields.netmask")} {status.netmask} · {t("network.config.fields.gateway")} {status.gateway}
                  </TooltipContent>
                </Tooltip>
                <Sub>
                  {status.viaDhcp ? t("network.summary.dhcp") : t("network.summary.staticIp")} ·{" "}
                  {status.linkUp ? t("network.summary.linkUp") : t("network.summary.linkDown")}
                </Sub>
              </>
            ) : (
              <Empty />
            )}
          </Kpi>

          <Kpi icon={<SlidersHorizontal aria-hidden />} label={t("network.summary.mode")}>
            {status ? (
              <>
                <span className={cn("text-base font-semibold", valueTone)}>{t(`network.modes.${status.workMode}`)}</span>
                <Sub>{isPlayableMode(status.workMode) ? t("network.header.modePlayable") : t("network.header.modeNotPlayable")}</Sub>
              </>
            ) : (
              <Empty />
            )}
          </Kpi>

          <Kpi icon={<Cpu aria-hidden />} label={t("network.summary.version")}>
            {status ? (
              <>
                <span className={cn("tabular text-base font-semibold", valueTone)}>{status.version || "—"}</span>
                {ota && !stale ? (
                  ota.pendingVerify ? (
                    <Sub className="font-medium text-warning">
                      <TriangleAlert className="size-3" aria-hidden />
                      {t("network.fw.pendingTitle")}
                    </Sub>
                  ) : (
                    <Sub className="text-success">
                      <ShieldCheck className="size-3" aria-hidden />
                      {t("network.header.fwVerified")}
                    </Sub>
                  )
                ) : (
                  <Sub>{ota ? ota.running : "—"}</Sub>
                )}
              </>
            ) : (
              <Empty />
            )}
          </Kpi>

          <Kpi icon={<HardDrive aria-hidden />} label={t("network.summary.sd")}>
            {status === null ? (
              <Empty />
            ) : status.sdMounted && total > 0 ? (
              <>
                <span className={cn("tabular text-base font-semibold", low ? "text-warning" : valueTone)}>
                  {t("network.header.sdFree", { free: formatBytes(free) })}
                </span>
                <span
                  role="progressbar"
                  aria-label={t("network.summary.sd")}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={usedPct}
                  aria-valuetext={t("network.summary.sdFree", { free: formatBytes(free), total: formatBytes(total) })}
                  className="mt-1.5 block h-1.5 w-full overflow-hidden rounded-full bg-surface-1"
                >
                  <span
                    className={cn("block h-full origin-left rounded-full", low ? "bg-warning" : "bg-primary")}
                    style={{ transform: `scaleX(${usedPct / 100})` }}
                  />
                </span>
                <Sub className={cn(low && "font-medium text-warning")}>
                  {low && <TriangleAlert className="size-3" aria-hidden />}
                  {t("network.header.sdTotal", { total: formatBytes(total) })}
                  {low ? ` · ${t("network.summary.sdLow")}` : ""}
                </Sub>
              </>
            ) : (
              <span className="text-base font-semibold text-muted-foreground">{t("network.summary.sdMissing")}</span>
            )}
          </Kpi>
        </dl>
      </section>
    </>
  );
}

function Kpi({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-surface-2 px-4 py-3 panel-edge">
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground [&_svg]:size-3.5">
        {icon}
        {label}
      </dt>
      <dd className="mt-1 flex min-w-0 flex-col">{children}</dd>
    </div>
  );
}

function Sub({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cn("mt-0.5 inline-flex items-center gap-1 truncate text-xs text-muted-foreground", className)}>{children}</span>;
}

function Empty() {
  return <span className="text-base font-semibold text-muted-foreground">—</span>;
}

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  RadarIcon,
  RefreshCw,
  Download,
  Trash2,
  Search,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/shared/components/PageHeader";
import { isTauri } from "@/shared/tauri/invoke";
import { saveTextFile } from "@/shared/tauri/files";
import { useEngineDataStore } from "@/shared/stores/engineDataStore";
import { useProtocolFlags } from "@/features/settings";
import type { Device, DeviceCategory } from "@/shared/domain/device";
import { DeviceRow } from "./DeviceRow";
import {
  clearOfflineDevices,
  getDevices,
  SCAN_ERR_ARTNET_DISABLED,
  SCAN_ERR_IN_PROGRESS,
  scanNetwork,
  setDeviceName,
} from "../lib/api";

type FilterKey = "all" | DeviceCategory;
type SortKey = "status" | "ip" | "name" | "lastSeen";

const FILTERS: { key: FilterKey; labelKey: string }[] = [
  { key: "all", labelKey: "discovery.filterAll" },
  { key: "artNet", labelKey: "discovery.filterArtNet" },
  { key: "sacn", labelKey: "discovery.filterSacn" },
  { key: "cluster", labelKey: "discovery.filterCluster" },
  { key: "computer", labelKey: "discovery.filterComputer" },
  { key: "network", labelKey: "discovery.filterNetwork" },
];

const SORTS: { key: SortKey; labelKey: string }[] = [
  { key: "status", labelKey: "discovery.sortStatus" },
  { key: "ip", labelKey: "discovery.sortIp" },
  { key: "name", labelKey: "discovery.sortName" },
  { key: "lastSeen", labelKey: "discovery.sortLastSeen" },
];

/** 用于按 IP 自然排序的数值化。 */
function ipToNumber(ip: string): number {
  return ip
    .split(".")
    .reduce((acc, part) => acc * 256 + (Number.parseInt(part, 10) || 0), 0);
}

function deviceName(d: Device): string {
  return (d.customName || d.hostname || d.ip).toLowerCase();
}

/**
 * 设备发现页：左侧过滤 / 在线筛选，右侧搜索 / 排序 / 刷新 / 导出 / 清理。
 */
export function DiscoveryView() {
  const { t } = useTranslation();
  const devices = useEngineDataStore((s) => s.devices);
  const setDevices = useEngineDataStore((s) => s.setDevices);
  // 设备的 lastSeenMs 与引擎运行时长同一时间基准
  const nowMs = useEngineDataStore((s) => s.stats.uptimeSec) * 1000;
  const { sacnEnabled } = useProtocolFlags();
  const [rawFilter, setFilter] = useState<FilterKey>("all");
  // sACN 关闭后其筛选标签消失：停在该标签上时回落到“全部”
  const filter: FilterKey = !sacnEnabled && rawFilter === "sacn" ? "all" : rawFilter;
  const filters = useMemo(
    () => FILTERS.filter((f) => sacnEnabled || f.key !== "sacn"),
    [sacnEnabled],
  );
  const [query, setQuery] = useState("");
  const [onlineOnly, setOnlineOnly] = useState(false);
  const [sort, setSort] = useState<SortKey>("status");
  const [scanning, setScanning] = useState(false);

  const counts = useMemo(() => {
    const base: Record<FilterKey, number> = {
      all: devices.length,
      artNet: 0,
      sacn: 0,
      cluster: 0,
      computer: 0,
      network: 0,
    };
    for (const d of devices) base[d.category] += 1;
    return base;
  }, [devices]);

  const onlineCount = useMemo(
    () => devices.filter((d) => d.online).length,
    [devices],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = devices.filter((d) => {
      if (filter !== "all" && d.category !== filter) return false;
      if (onlineOnly && !d.online) return false;
      if (!q) return true;
      return (
        d.ip.toLowerCase().includes(q) ||
        (d.hostname ?? "").toLowerCase().includes(q) ||
        (d.customName ?? "").toLowerCase().includes(q) ||
        (d.mac ?? "").toLowerCase().includes(q)
      );
    });

    return [...list].sort((a, b) => {
      switch (sort) {
        case "ip":
          return ipToNumber(a.ip) - ipToNumber(b.ip);
        case "name":
          return deviceName(a).localeCompare(deviceName(b));
        case "lastSeen":
          return b.lastSeenMs - a.lastSeenMs;
        case "status":
        default:
          if (a.online !== b.online) return a.online ? -1 : 1;
          return ipToNumber(a.ip) - ipToNumber(b.ip);
      }
    });
  }, [devices, filter, query, onlineOnly, sort]);

  /** 把后端扫描错误码 / 异常转换为用户可读文案。 */
  const describeScanError = (e: unknown): string => {
    const raw = e instanceof Error ? e.message : String(e);
    if (raw === SCAN_ERR_ARTNET_DISABLED) return t("discovery.scanErrArtnetDisabled");
    if (raw === SCAN_ERR_IN_PROGRESS) return t("discovery.scanErrInProgress");
    return t("discovery.scanFailed", { reason: raw });
  };

  const handleScan = async () => {
    if (scanning) return;
    if (!isTauri()) {
      toast.info(t("discovery.scanDesktopOnly"));
      return;
    }
    setScanning(true);
    try {
      const result = await scanNetwork();
      if (result.responded > 0) {
        toast.success(
          t("discovery.scanDone", {
            responded: result.responded,
            total: result.totalArtnet,
          }),
        );
      } else {
        toast.warning(t("discovery.scanNoReply"));
      }
      if (result.errors.length > 0) {
        toast.warning(
          t("discovery.scanPartial", { reason: result.errors.join("; ") }),
        );
      }
    } catch (e: unknown) {
      toast.error(describeScanError(e));
    } finally {
      setScanning(false);
    }
  };

  const handleRefresh = () => {
    if (!isTauri()) return;
    void getDevices()
      .then(setDevices)
      .catch((e: unknown) =>
        toast.error(e instanceof Error ? e.message : String(e)),
      );
  };

  const handleClearOffline = () => {
    const offline = devices.filter((d) => !d.online).length;
    if (!isTauri()) {
      setDevices(devices.filter((d) => d.online));
      toast.success(t("discovery.clearedOffline", { n: offline }));
      return;
    }
    void clearOfflineDevices()
      .then((left) => {
        setDevices(left);
        toast.success(t("discovery.clearedOffline", { n: offline }));
      })
      .catch((e: unknown) =>
        toast.error(e instanceof Error ? e.message : String(e)),
      );
  };

  const handleExport = () => {
    void saveTextFile("art-net-devices.json", JSON.stringify(filtered, null, 2));
  };

  const handleRename = (ip: string, name: string) => {
    void setDeviceName(ip, name).catch((e: unknown) =>
      toast.error(e instanceof Error ? e.message : String(e)),
    );
  };

  const hasOffline = devices.some((d) => !d.online);

  return (
    <div>
      <PageHeader
        title={t("discovery.title")}
        subtitle={t(sacnEnabled ? "discovery.subtitle" : "discovery.subtitleArtnetOnly")}
        actions={
          <Button
            size="sm"
            onClick={() => void handleScan()}
            disabled={scanning}
            aria-busy={scanning}
          >
            {scanning ? <Loader2 className="animate-spin" /> : <RadarIcon />}
            {scanning ? t("discovery.scanning") : t("discovery.networkScan")}
          </Button>
        }
      />

      <div className="mb-(--density-gutter) flex flex-wrap items-center gap-x-6 gap-y-4">
        {/* 左侧：分类过滤 + 在线筛选 */}
        <div className="flex flex-wrap items-center gap-1">
          {filters.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={cn(
                "flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                filter === f.key
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-accent",
              )}
            >
              {t(f.labelKey)}
              <span className="tabular text-[0.7rem] opacity-70">
                {counts[f.key]}
              </span>
            </button>
          ))}
        </div>

        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch checked={onlineOnly} onCheckedChange={setOnlineOnly} />
          {t("discovery.onlineOnly")}
        </label>

        {/* 右侧：搜索 + 排序 + 操作 */}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="relative w-56">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("discovery.searchPlaceholder")}
              className="pl-8"
            />
          </div>

          <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
            <SelectTrigger className="w-36" aria-label={t("discovery.sortBy")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORTS.map((s) => (
                <SelectItem key={s.key} value={s.key}>
                  {t(s.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            variant="outline"
            size="icon"
            onClick={handleRefresh}
            aria-label={t("discovery.refresh")}
            title={t("discovery.refresh")}
          >
            <RefreshCw />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={handleExport}
            disabled={filtered.length === 0}
            aria-label={t("common.export")}
            title={t("common.export")}
          >
            <Download />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={handleClearOffline}
            disabled={!hasOffline}
            aria-label={t("discovery.clearOffline")}
            title={t("discovery.clearOffline")}
          >
            <Trash2 />
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="pt-8">
          <div className="mb-3 flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {t("discovery.summary", {
                total: devices.length,
                online: onlineCount,
              })}
            </span>
            {filtered.length !== devices.length && (
              <span className="tabular">
                {t("discovery.shown", { n: filtered.length })}
              </span>
            )}
          </div>

          <div className="grid grid-cols-[5rem_8rem_1fr_9rem_6rem_6rem_7rem] gap-x-4 border-b border-border pb-3 text-xs font-medium text-muted-foreground">
            <span>{t("discovery.colStatus")}</span>
            <span>{t("discovery.colIp")}</span>
            <span>{t("discovery.colHostname")}</span>
            <span>{t("discovery.colMac")}</span>
            <span>{t("discovery.colCategory")}</span>
            <span className="text-right">{t("discovery.colArtnet")}</span>
            <span className="text-right">{t("discovery.colLastSeen")}</span>
          </div>
          {filtered.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              {t("discovery.noDevices")}
            </div>
          ) : (
            <div className="divide-y divide-border">
              {filtered.map((d) => (
                <DeviceRow
                  key={d.ip}
                  device={d}
                  nowMs={nowMs}
                  onRename={handleRename}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

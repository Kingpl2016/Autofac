import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Loader2, Radar as RadarIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/components/PageHeader";
import { isTauri } from "@/shared/tauri/invoke";
import { saveTextFile } from "@/shared/tauri/files";
import { useEngineDataStore } from "@/shared/stores/engineDataStore";
import { useProtocolFlags } from "@/features/settings";
import { FORWARDING_PATH, forwardingPrefillState } from "@/features/forwarding";
import type { Device } from "@/shared/domain/device";
import { ClearOfflineDialog } from "./ClearOfflineDialog";
import { DeviceDetailPanel } from "./DeviceDetailPanel";
import { DeviceTable, type DeviceTableHandle } from "./DeviceTable";
import { DiscoveryEmptyState } from "./DiscoveryEmptyState";
import { DiscoveryToolbar } from "./DiscoveryToolbar";
import { ScanStatusBar } from "./ScanStatusBar";
import type { SegmentOption } from "./SegmentedControl";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { useDiscoveryPrefs } from "../hooks/useDiscoveryPrefs";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useNetworkScan } from "../hooks/useNetworkScan";
import { useNewDevices } from "../hooks/useNewDevices";
import {
  countByCategory,
  filterDevices,
  isFiltering,
  nextSort,
  sortDevices,
  type CategoryFilter,
  type SortKey,
} from "../lib/filters";
import { clearOfflineDevices, getDevices, setDeviceName } from "../lib/api";

/** 分类筛选的显示顺序与文案键。 */
const CATEGORY_ORDER: { value: CategoryFilter; labelKey: string }[] = [
  { value: "all", labelKey: "discovery.filterAll" },
  { value: "artNet", labelKey: "discovery.filterArtNet" },
  { value: "sacn", labelKey: "discovery.filterSacn" },
  { value: "cluster", labelKey: "discovery.filterCluster" },
  { value: "computer", labelKey: "discovery.filterComputer" },
  { value: "network", labelKey: "discovery.filterNetwork" },
];

/** 判断键盘事件是否发生在可输入元素里（此时不触发全局快捷键）。 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

/**
 * 设备发现页：扫描状态条 + 筛选工具栏 + 设备表格，选中设备后右侧并排显示详情面板。
 * 分类 / 在线状态 / 排序会经 Tauri Store 保存，下次打开自动恢复；搜索词与选中项不保存。
 */
export function DiscoveryView() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const copy = useCopyToClipboard();
  const devices = useEngineDataStore((s) => s.devices);
  const setDevices = useEngineDataStore((s) => s.setDevices);
  const { sacnEnabled } = useProtocolFlags();
  const { scanning, last, showNoReply, scan, dismissNoReply } = useNetworkScan();
  const freshIps = useNewDevices();
  const wide = useMediaQuery("(min-width: 1280px)");

  const rawCategory = useDiscoveryPrefs((s) => s.category);
  const status = useDiscoveryPrefs((s) => s.status);
  const sort = useDiscoveryPrefs((s) => s.sort);
  const setCategory = useDiscoveryPrefs((s) => s.setCategory);
  const setStatus = useDiscoveryPrefs((s) => s.setStatus);
  const setSort = useDiscoveryPrefs((s) => s.setSort);
  const clearPrefFilters = useDiscoveryPrefs((s) => s.clearFilters);
  // sACN 关闭后其筛选标签消失：停在该标签上时回落到“全部”
  const category: CategoryFilter =
    !sacnEnabled && rawCategory === "sacn" ? "all" : rawCategory;

  const [query, setQuery] = useState("");
  const [selectedIp, setSelectedIp] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const tableRef = useRef<DeviceTableHandle>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // `/` 聚焦搜索框（不在输入框里、没有修饰键时）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const counts = useMemo(() => countByCategory(devices), [devices]);
  const onlineCount = useMemo(() => devices.filter((d) => d.online).length, [devices]);
  const offlineCount = devices.length - onlineCount;

  const categoryOptions = useMemo<SegmentOption<CategoryFilter>[]>(
    () =>
      CATEGORY_ORDER.filter((c) => sacnEnabled || c.value !== "sacn").map((c) => ({
        value: c.value,
        label: t(c.labelKey),
        count: counts[c.value],
      })),
    [sacnEnabled, counts, t],
  );

  const filter = useMemo(() => ({ category, status, query }), [category, status, query]);
  const filtering = isFiltering(filter);
  const visible = useMemo(
    () => sortDevices(filterDevices(devices, filter), sort.key, sort.dir),
    [devices, filter, sort],
  );
  const selected = useMemo(
    () => devices.find((d) => d.ip === selectedIp) ?? null,
    [devices, selectedIp],
  );

  const handleSelect = useCallback((ip: string | null) => {
    setSelectedIp(ip);
    setRenaming(false);
  }, []);

  const handleRenameRequest = useCallback((ip: string) => {
    setSelectedIp(ip);
    setRenaming(true);
  }, []);

  const handleClosePanel = () => {
    const ip = selectedIp;
    handleSelect(null);
    // 把焦点还给原来的行，键盘用户不会丢失位置
    if (ip) requestAnimationFrame(() => tableRef.current?.focusRow(ip));
  };

  const handleSort = (key: SortKey) => setSort(nextSort(sort, key));

  const clearFilters = () => {
    clearPrefFilters();
    setQuery("");
  };

  const handleRefresh = () => {
    if (!isTauri()) return;
    void getDevices()
      .then(setDevices)
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e)));
  };

  const handleClearOffline = () => {
    const n = offlineCount;
    if (!isTauri()) {
      setDevices(devices.filter((d) => d.online));
      toast.success(t("discovery.clearedOffline", { n }));
      return;
    }
    void clearOfflineDevices()
      .then((left) => {
        setDevices(left);
        toast.success(t("discovery.clearedOffline", { n }));
      })
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e)));
  };

  const handleExport = () => {
    void saveTextFile("art-net-devices.json", JSON.stringify(visible, null, 2));
  };

  const handleRename = (ip: string, name: string) => {
    // 先本地更新，界面立即反映；后端持久化失败时再提示
    setDevices(devices.map((d) => (d.ip === ip ? { ...d, customName: name || null } : d)));
    void setDeviceName(ip, name).catch((e: unknown) =>
      toast.error(e instanceof Error ? e.message : String(e)),
    );
  };

  const handleAddToForwarding = (d: Device) => {
    navigate(FORWARDING_PATH, {
      state: forwardingPrefillState({
        name: d.customName || d.hostname || d.shortName || "",
        targetIp: d.ip,
      }),
    });
  };

  // 窄窗口或打开详情时隐藏 MAC 列（详情里有完整信息），保证主要列不被挤压
  const showMac = wide && !selected;

  return (
    <div className="flex h-full min-h-[28rem] flex-col gap-4">
      <PageHeader
        className="mb-0"
        title={t("discovery.title")}
        subtitle={t(sacnEnabled ? "discovery.subtitle" : "discovery.subtitleArtnetOnly")}
        actions={
          <Button size="sm" onClick={() => void scan()} disabled={scanning} aria-busy={scanning}>
            {scanning ? <Loader2 className="animate-spin" /> : <RadarIcon />}
            {scanning ? t("discovery.scanning") : t("discovery.networkScan")}
          </Button>
        }
      />

      <ScanStatusBar
        scanning={scanning}
        last={last}
        showNoReply={showNoReply}
        onDismissNoReply={dismissNoReply}
      />

      <DiscoveryToolbar
        query={query}
        onQueryChange={setQuery}
        searchRef={searchRef}
        categoryOptions={categoryOptions}
        category={category}
        onCategoryChange={setCategory}
        statusCounts={{ all: devices.length, online: onlineCount, offline: offlineCount }}
        status={status}
        onStatusChange={setStatus}
        canExport={visible.length > 0}
        onExport={handleExport}
        offlineCount={offlineCount}
        onClearOffline={() => setClearOpen(true)}
        onRefresh={handleRefresh}
      />

      <div className="flex min-h-0 flex-1 gap-4">
        <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card">
          <div className="min-h-0 flex-1 overflow-auto">
            {devices.length === 0 ? (
              <DiscoveryEmptyState
                kind="none"
                scanning={scanning}
                onScan={() => void scan()}
                onClearFilters={clearFilters}
              />
            ) : visible.length === 0 ? (
              <DiscoveryEmptyState
                kind="filtered"
                scanning={scanning}
                onScan={() => void scan()}
                onClearFilters={clearFilters}
              />
            ) : (
              <DeviceTable
                ref={tableRef}
                devices={visible}
                sort={sort}
                onSort={handleSort}
                selectedIp={selected?.ip ?? null}
                onSelect={handleSelect}
                freshIps={freshIps}
                showMac={showMac}
                onRename={handleRenameRequest}
              />
            )}
          </div>

          <footer className="flex min-h-10 items-center justify-between gap-4 border-t border-border px-4 text-xs text-muted-foreground">
            <span>
              {t("discovery.summary", { total: devices.length, online: onlineCount })}
            </span>
            {filtering && devices.length > 0 && (
              <span className="flex items-center gap-2">
                <span className="tabular">
                  {t("discovery.filtered", { shown: visible.length, total: devices.length })}
                </span>
                <Button variant="link" className="h-auto p-0 text-xs" onClick={clearFilters}>
                  {t("discovery.clearFilters")}
                </Button>
              </span>
            )}
          </footer>
        </section>

        {selected && (
          <DeviceDetailPanel
            key={selected.ip}
            device={selected}
            renaming={renaming}
            onRenamingChange={setRenaming}
            onRename={handleRename}
            onCopy={copy}
            onAddToForwarding={handleAddToForwarding}
            onClose={handleClosePanel}
          />
        )}
      </div>

      <ClearOfflineDialog
        open={clearOpen}
        count={offlineCount}
        onOpenChange={setClearOpen}
        onConfirm={handleClearOffline}
      />
    </div>
  );
}

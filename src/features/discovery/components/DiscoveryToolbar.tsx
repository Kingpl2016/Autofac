import type { Ref } from "react";
import { useTranslation } from "react-i18next";
import { Download, Network, RefreshCw, Search, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CategoryFilter, StatusFilter } from "../lib/filters";
import { SegmentedControl, type SegmentOption } from "../../../shared/components/SegmentedControl";

interface DiscoveryToolbarProps {
  query: string;
  onQueryChange: (query: string) => void;
  searchRef: Ref<HTMLInputElement>;
  categoryOptions: readonly SegmentOption<CategoryFilter>[];
  category: CategoryFilter;
  onCategoryChange: (category: CategoryFilter) => void;
  statusCounts: { all: number; online: number; offline: number };
  status: StatusFilter;
  onStatusChange: (status: StatusFilter) => void;
  /** MAC 列是否开启（偏好）。 */
  showMac: boolean;
  onToggleMac: () => void;
  canExport: boolean;
  onExport: () => void;
  offlineCount: number;
  onClearOffline: () => void;
  onRefresh: () => void;
}

/**
 * 工具栏：左侧是搜索与两组筛选（分类 / 在线状态），右侧是导出、清理离线、刷新。
 * 两组筛选始终可见（不藏进菜单），方便一眼看出当前生效的条件。
 */
export function DiscoveryToolbar({
  query,
  onQueryChange,
  searchRef,
  categoryOptions,
  category,
  onCategoryChange,
  statusCounts,
  status,
  onStatusChange,
  showMac,
  onToggleMac,
  canExport,
  onExport,
  offlineCount,
  onClearOffline,
  onRefresh,
}: DiscoveryToolbarProps) {
  const { t } = useTranslation();

  const statusOptions: SegmentOption<StatusFilter>[] = [
    { value: "all", label: t("discovery.statusAll"), count: statusCounts.all },
    { value: "online", label: t("discovery.statusOnline"), count: statusCounts.online },
    { value: "offline", label: t("discovery.statusOffline"), count: statusCounts.offline },
  ];

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
      <div className="relative w-64">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.preventDefault();
              onQueryChange("");
            }
          }}
          aria-label={t("discovery.searchLabel")}
          aria-keyshortcuts="/"
          placeholder={t("discovery.searchPlaceholder")}
          className="h-10 pl-9 pr-9 [&::-webkit-search-cancel-button]:appearance-none"
        />
        {query && (
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-1 top-1/2 size-8 -translate-y-1/2 text-muted-foreground"
            aria-label={t("discovery.clearSearch")}
            title={t("discovery.clearSearch")}
            onClick={() => onQueryChange("")}
          >
            <X className="size-4" />
          </Button>
        )}
      </div>

      <SegmentedControl
        label={t("discovery.categoryFilterLabel")}
        options={categoryOptions}
        value={category}
        onChange={onCategoryChange}
      />
      <SegmentedControl
        label={t("discovery.statusFilterLabel")}
        options={statusOptions}
        value={status}
        onChange={onStatusChange}
      />

      <div className="ml-auto flex items-center gap-2">
        <Button
          variant={showMac ? "secondary" : "outline"}
          size="sm"
          aria-pressed={showMac}
          onClick={onToggleMac}
          title={t("discovery.toggleMacHint")}
        >
          <Network />
          {t("discovery.toggleMac")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onExport}
          disabled={!canExport}
          title={t("discovery.exportList")}
        >
          <Download />
          {t("common.export")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onClearOffline}
          disabled={offlineCount === 0}
          title={t("discovery.clearOffline")}
        >
          <Trash2 />
          {t("discovery.clearOffline")}
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="size-10"
          onClick={onRefresh}
          aria-label={t("discovery.refresh")}
          title={t("discovery.refresh")}
        >
          <RefreshCw />
        </Button>
      </div>
    </div>
  );
}

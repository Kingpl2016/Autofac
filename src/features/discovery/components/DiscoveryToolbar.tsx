import type { ReactNode, Ref } from "react";
import { useTranslation } from "react-i18next";
import { Download, Network, RefreshCw, Search, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { CategoryFilter, StatusFilter } from "../lib/filters";
import { SegmentedControl, type SegmentOption } from "@/shared/components/SegmentedControl";

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
 * 工具栏：左侧是搜索与两组筛选（分类 / 在线状态，空间不够时在左侧区域内换行），
 * 右侧是 MAC 列、导出、清理离线、刷新（固定在第一行最右，不会被挤到单独一行）。
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

  // 左侧筛选区：空间不够时在区域内换行
  const filters = (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2">
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
    </div>
  );

  // 右侧操作组：不收缩、不换行，始终停在第一行最右；窗口窄于 1800px 时只留图标（文字留给读屏，悬停给出提示）
  const actions = (
    <div className="flex shrink-0 items-center gap-2">
      <ToolButton
        icon={<Network />}
        label={t("discovery.toggleMac")}
        hint={t("discovery.toggleMacHint")}
        variant={showMac ? "secondary" : "outline"}
        pressed={showMac}
        onClick={onToggleMac}
      />
      <ToolButton
        icon={<Download />}
        label={t("common.export")}
        hint={t("discovery.exportList")}
        disabled={!canExport}
        onClick={onExport}
      />
      <ToolButton
        icon={<Trash2 />}
        label={t("discovery.clearOffline")}
        hint={t("discovery.clearOffline")}
        disabled={offlineCount === 0}
        onClick={onClearOffline}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className="size-10"
            onClick={onRefresh}
            aria-label={t("discovery.refresh")}
          >
            <RefreshCw />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t("discovery.refresh")}</TooltipContent>
      </Tooltip>
    </div>
  );

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex items-start gap-3">
        {filters}
        {actions}
      </div>
    </TooltipProvider>
  );
}

interface ToolButtonProps {
  icon: ReactNode;
  label: string;
  hint: string;
  variant?: "outline" | "secondary";
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

/**
 * 工具栏按钮：很宽的窗口（≥ 1800px，筛选与按钮能排进一行）显示图标 + 文字；更窄时只显示图标，文字仍在按钮里供读屏，
 * 悬停 / 键盘聚焦时用提示给出名称。禁用的按钮不响应悬停，所以提示包在外层 `span` 上。
 */
function ToolButton({ icon, label, hint, variant = "outline", pressed, disabled, onClick }: ToolButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex" tabIndex={disabled ? 0 : undefined}>
          <Button
            variant={variant}
            size="sm"
            className="max-[1800px]:w-10 max-[1800px]:px-0"
            aria-pressed={pressed}
            disabled={disabled}
            onClick={onClick}
          >
            {icon}
            <span className="max-[1800px]:sr-only">{label}</span>
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{hint}</TooltipContent>
    </Tooltip>
  );
}

import { useTranslation } from "react-i18next";
import { Loader2, Radar, SearchX } from "lucide-react";

import { Button } from "@/components/ui/button";

interface DiscoveryEmptyStateProps {
  /** `none`：一台设备都没有；`filtered`：有设备但被筛选条件排除 */
  kind: "none" | "filtered";
  scanning: boolean;
  onScan: () => void;
  onClearFilters: () => void;
}

/**
 * 空状态。区分“还没发现设备”（引导去扫描）与“筛选后为空”（引导清除筛选），
 * 各给一个明确的下一步按钮。
 */
export function DiscoveryEmptyState({
  kind,
  scanning,
  onScan,
  onClearFilters,
}: DiscoveryEmptyStateProps) {
  const { t } = useTranslation();

  if (kind === "filtered") {
    return (
      <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
        <SearchX className="size-8 text-muted-foreground" aria-hidden />
        <div>
          <p className="font-medium">{t("discovery.emptyFilteredTitle")}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("discovery.emptyFilteredDesc")}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onClearFilters}>
          {t("discovery.clearFilters")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
      <Radar className="size-8 text-muted-foreground" aria-hidden />
      <div>
        <p className="font-medium">{t("discovery.emptyTitle")}</p>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          {t("discovery.emptyDesc")}
        </p>
      </div>
      <Button size="sm" onClick={onScan} disabled={scanning} aria-busy={scanning}>
        {scanning ? <Loader2 className="animate-spin" /> : <Radar />}
        {scanning ? t("discovery.scanning") : t("discovery.emptyScan")}
      </Button>
    </div>
  );
}

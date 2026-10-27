import { useTranslation } from "react-i18next";
import { AlertCircle, Circle, Clapperboard, Library, RefreshCw, SearchX } from "lucide-react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";

interface LibraryEmptyStateProps {
  /** `none`：节目库为空；`filtered`：被筛选条件排除；`error`：列表读取失败 */
  kind: "none" | "filtered" | "error";
  /** 失败原因（`error` 时显示） */
  reason?: string;
  onClearFilters: () => void;
  onRetry: () => void;
}

/** 空状态：每种情况都给出明确的下一步。 */
export function LibraryEmptyState({ kind, reason, onClearFilters, onRetry }: LibraryEmptyStateProps) {
  const { t } = useTranslation();

  if (kind === "error") {
    return (
      <div role="alert" className="flex flex-col items-center gap-3 px-6 py-16 text-center">
        <AlertCircle className="size-8 text-destructive" aria-hidden />
        <div>
          <p className="font-medium">{t("library.loadFailed")}</p>
          {reason && <p className="mt-1 max-w-md text-sm break-words text-muted-foreground">{reason}</p>}
        </div>
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw />
          {t("library.retry")}
        </Button>
      </div>
    );
  }

  if (kind === "filtered") {
    return (
      <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
        <SearchX className="size-8 text-muted-foreground" aria-hidden />
        <div>
          <p className="font-medium">{t("library.emptyFilteredTitle")}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t("library.emptyFilteredDesc")}</p>
        </div>
        <Button variant="outline" size="sm" onClick={onClearFilters}>
          {t("library.clearFilters")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
      <Library className="size-8 text-muted-foreground" aria-hidden />
      <div>
        <p className="font-medium">{t("library.emptyTitle")}</p>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">{t("library.emptyDesc")}</p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Button asChild size="sm">
          <Link to="/recording">
            <Circle />
            {t("library.goRecord")}
          </Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link to="/editor">
            <Clapperboard />
            {t("library.newShow")}
          </Link>
        </Button>
      </div>
    </div>
  );
}

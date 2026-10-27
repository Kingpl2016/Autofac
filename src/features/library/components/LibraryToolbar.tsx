import type { Ref } from "react";
import { useTranslation } from "react-i18next";
import { Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SegmentedControl, type SegmentOption } from "@/shared/components/SegmentedControl";
import { KIND_FILTERS, type KindFilter } from "../lib/libraryFilters";

/** 类别 → 文案键。 */
const KIND_LABEL: Record<KindFilter, string> = {
  all: "library.kindAll",
  recorded: "library.kindRecorded",
  editor: "library.kindEditor",
  issues: "library.kindIssues",
};

interface LibraryToolbarProps {
  query: string;
  onQueryChange: (query: string) => void;
  searchRef: Ref<HTMLInputElement>;
  kind: KindFilter;
  onKindChange: (kind: KindFilter) => void;
  counts: Record<KindFilter, number>;
}

/** 工具栏：搜索（`/` 聚焦、Esc 清空）+ 类别筛选（始终可见，一眼看出当前条件）。 */
export function LibraryToolbar({ query, onQueryChange, searchRef, kind, onKindChange, counts }: LibraryToolbarProps) {
  const { t } = useTranslation();
  const options: SegmentOption<KindFilter>[] = KIND_FILTERS.map((k) => ({
    value: k,
    label: t(KIND_LABEL[k]),
    count: counts[k],
  }));

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="relative w-72 max-w-full">
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
          aria-label={t("library.searchLabel")}
          aria-keyshortcuts="/"
          placeholder={t("library.searchPlaceholder")}
          className="h-10 pl-9 pr-9 [&::-webkit-search-cancel-button]:appearance-none"
        />
        {query && (
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-1 top-1/2 size-8 -translate-y-1/2 text-muted-foreground"
            aria-label={t("library.clearSearch")}
            title={t("library.clearSearch")}
            onClick={() => onQueryChange("")}
          >
            <X className="size-4" />
          </Button>
        )}
      </div>
      <SegmentedControl label={t("library.kindLabel")} options={options} value={kind} onChange={onKindChange} />
    </div>
  );
}

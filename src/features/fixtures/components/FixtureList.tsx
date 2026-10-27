import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { filterModels } from "../lib/format";
import type { FixtureModel } from "../lib/types";
import { channelCount } from "../lib/validate";

interface FixtureListProps {
  models: readonly FixtureModel[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  query: string;
  onQueryChange: (query: string) => void;
}

/** 左侧模型列表：搜索框 + “内置 / 自定义”两组。 */
export function FixtureList({ models, selectedId, onSelect, query, onQueryChange }: FixtureListProps) {
  const { t } = useTranslation();
  const filtered = useMemo(() => filterModels(models, query), [models, query]);
  const groups = [
    { key: "builtin", title: t("fixtures.list.builtin"), items: filtered.filter((m) => m.builtin) },
    { key: "custom", title: t("fixtures.list.custom"), items: filtered.filter((m) => !m.builtin) },
  ];

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={t("fixtures.list.search")}
          aria-label={t("fixtures.list.search")}
          className="h-9 pl-9"
        />
      </div>
      {filtered.length === 0 && (
        <p className="px-1 text-sm text-muted-foreground">{t("fixtures.list.noMatch")}</p>
      )}
      {groups.map(
        (group) =>
          group.items.length > 0 && (
            <section key={group.key} aria-label={group.title}>
              <h3 className="mb-1 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {group.title}
              </h3>
              <ul className="flex flex-col gap-0.5">
                {group.items.map((m) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(m.id)}
                      aria-current={m.id === selectedId ? "true" : undefined}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                        "hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        "aria-[current=true]:bg-accent aria-[current=true]:text-accent-foreground",
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{m.name}</span>
                        <span className="num block truncate text-xs text-muted-foreground">{m.id}</span>
                      </span>
                      <span className="num shrink-0 text-xs text-muted-foreground">
                        {t("fixtures.list.channels", { count: channelCount(m) })}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ),
      )}
    </div>
  );
}

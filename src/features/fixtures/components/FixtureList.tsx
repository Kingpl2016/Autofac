import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Segmented } from "@/shared/components/Segmented";
import { filterModels } from "../lib/format";
import { FIXTURE_TYPES, modelType, type FixtureType } from "../lib/profile";
import type { FixtureModel } from "../lib/types";
import { channelCount } from "../lib/validate";
import { FixtureTypeIcon } from "./FixtureTypeIcon";

/** 来源筛选。 */
type SourceFilter = "all" | "builtin" | "custom";

interface FixtureListProps {
  models: readonly FixtureModel[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  query: string;
  onQueryChange: (query: string) => void;
}

/**
 * 左侧模型列表：搜索框、来源（全部 / 内置 / 自定义）与类型筛选，按“内置 / 自定义”分组列出。
 * 每一项显示类型图标、名称、编号、通道数与模式数。
 */
export function FixtureList({ models, selectedId, onSelect, query, onQueryChange }: FixtureListProps) {
  const { t } = useTranslation();
  const [source, setSource] = useState<SourceFilter>("all");
  const [type, setType] = useState<FixtureType | "all">("all");

  const typed = useMemo(() => new Map(models.map((m) => [m.id, modelType(m)])), [models]);
  const searched = useMemo(
    () => filterModels(models, query).filter((m) => source === "all" || (source === "builtin") === m.builtin),
    [models, query, source],
  );
  const counts = new Map<FixtureType, number>();
  for (const m of searched) {
    const ft = typed.get(m.id) ?? "other";
    counts.set(ft, (counts.get(ft) ?? 0) + 1);
  }
  const filtered = type === "all" ? searched : searched.filter((m) => typed.get(m.id) === type);
  const groups = [
    { key: "builtin", title: t("fixtures.list.builtin"), items: filtered.filter((m) => m.builtin) },
    { key: "custom", title: t("fixtures.list.custom"), items: filtered.filter((m) => !m.builtin) },
  ];
  const filtering = query.trim() !== "" || source !== "all" || type !== "all";

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={t("fixtures.list.search")}
          aria-label={t("fixtures.list.search")}
          className="h-9 pl-9"
        />
      </div>
      <Segmented<SourceFilter>
        size="xs"
        className="self-start"
        ariaLabel={t("fixtures.list.source")}
        value={source}
        onChange={setSource}
        options={[
          { value: "all", label: t("fixtures.list.all") },
          { value: "builtin", label: t("fixtures.detail.builtin") },
          { value: "custom", label: t("fixtures.detail.custom") },
        ]}
      />
      <div role="group" aria-label={t("fixtures.list.typeFilter")} className="flex flex-wrap gap-1">
        {[{ value: "all" as const, count: searched.length }, ...FIXTURE_TYPES.filter((ft) => counts.has(ft)).map((ft) => ({ value: ft, count: counts.get(ft) ?? 0 }))].map(
          (c) => (
            <button
              key={c.value}
              type="button"
              aria-pressed={type === c.value}
              onClick={() => setType(c.value)}
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                type === c.value ? "border-primary bg-primary/15 text-foreground" : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {c.value !== "all" && <FixtureTypeIcon type={c.value} labelled={false} />}
              {c.value === "all" ? t("fixtures.list.all") : t(`fixtures.type.${c.value}`)}
              <span className="num text-muted-foreground">{c.count}</span>
            </button>
          ),
        )}
      </div>

      {filtered.length === 0 && (
        <div className="flex flex-col items-start gap-2 px-1">
          <p className="text-sm text-muted-foreground">{t("fixtures.list.noMatch")}</p>
          {filtering && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                onQueryChange("");
                setSource("all");
                setType("all");
              }}
            >
              {t("fixtures.list.clearFilters")}
            </Button>
          )}
        </div>
      )}
      {groups.map(
        (group) =>
          group.items.length > 0 && (
            <section key={group.key} aria-label={group.title}>
              <h3 className="mb-1 flex items-center justify-between px-1 text-xs font-medium tracking-wider text-muted-foreground uppercase">
                {group.title}
                <span className="num font-normal normal-case">{group.items.length}</span>
              </h3>
              <ul className="flex flex-col gap-0.5">
                {group.items.map((m) => (
                  <li key={m.id}>
                    <ModelItem model={m} type={typed.get(m.id) ?? "other"} current={m.id === selectedId} onSelect={onSelect} />
                  </li>
                ))}
              </ul>
            </section>
          ),
      )}
    </div>
  );
}

/** 列表里的一个模型。 */
function ModelItem({
  model,
  type,
  current,
  onSelect,
}: {
  model: FixtureModel;
  type: FixtureType;
  current: boolean;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const modes = 1 + (model.modes?.length ?? 0);
  return (
    <button
      type="button"
      onClick={() => onSelect(model.id)}
      aria-current={current ? "true" : undefined}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md border border-transparent px-2 py-1.5 text-left text-sm transition-colors",
        "hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "aria-[current=true]:border-primary/40 aria-[current=true]:bg-accent aria-[current=true]:text-accent-foreground",
      )}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-2 text-primary">
        <FixtureTypeIcon type={type} labelled={false} className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{model.name}</span>
        <span className="num block truncate text-xs text-muted-foreground">
          {model.id}
          {model.manufacturer ? ` · ${model.manufacturer}` : ""}
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5">
        <span className="num text-xs text-muted-foreground">{t("fixtures.list.channels", { count: channelCount(model) })}</span>
        {modes > 1 && <span className="num rounded-sm bg-surface-2 px-1 text-[10px] text-muted-foreground">{t("fixtures.list.modes", { count: modes })}</span>}
      </span>
    </button>
  );
}

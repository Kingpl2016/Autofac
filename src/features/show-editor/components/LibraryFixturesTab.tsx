import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, History, Rows2, Rows3, Search, Star, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  FIXTURE_TYPES,
  FixtureTypeIcon,
  modelType,
  useFixtureStore,
  type FixtureModel,
  type FixtureType,
} from "@/features/fixtures";
import { cn } from "@/lib/utils";
import { useEditorPrefsStore, type FixtureLibrarySection } from "../stores/useEditorPrefsStore";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { EmptyHint } from "./EmptyHint";
import { FixtureModelCard } from "./FixtureModelCard";

/** 从左侧灯具页拖出的模型（可放到 Patch 的 Universe 卡片、舞台监视器或时间线）。 */
export interface FixtureModelDragData {
  kind: "fixtureModel";
  modelId: string;
  name: string;
  type: FixtureType;
}

/** 类型筛选：全部或某一类。 */
type TypeFilter = "all" | FixtureType;

/** 模型与它的类型。 */
interface Typed {
  model: FixtureModel;
  type: FixtureType;
}

/**
 * 模型是否匹配搜索词（名称、编号、厂商、产品类型，不区分大小写）。
 *
 * @param m 模型。
 * @param q 已转小写、去首尾空白的搜索词。
 * @returns 是否匹配。
 */
function matches(m: FixtureModel, q: string): boolean {
  if (!q) return true;
  return [m.name, m.id, m.manufacturer ?? "", m.productType, m.system].some((s) => s.toLowerCase().includes(q));
}

/** 按 id 列表取模型（保持列表顺序，跳过已不存在的模型）。 */
function pickByIds(byId: ReadonlyMap<string, Typed>, ids: readonly string[]): Typed[] {
  return ids.map((id) => byId.get(id)).filter((x): x is Typed => x !== undefined);
}

/**
 * 素材库的“灯具”标签页：顶部吸顶的搜索、类型筛选与密度切换；下面是“收藏”“最近添加”和按类型折叠的分组。
 * 每张卡片可拖到 Patch / 舞台 / 时间线，“+”快速加 1 台，展开后批量添加（带实时地址预览）。
 * 新灯具自动分配 DMX 地址、各自生成一条轨道，并被选中以便立刻编组或改名。
 *
 * 搜索或按类型筛选时只显示类型分组，且全部展开。
 */
export function LibraryFixturesTab() {
  const { t } = useTranslation();
  const models = useFixtureStore((s) => s.models);
  const status = useFixtureStore((s) => s.status);
  const load = useFixtureStore((s) => s.load);
  const prefs = useEditorPrefsStore((s) => s.fixtureLibrary);
  const setPrefs = useEditorPrefsStore((s) => s.setFixtureLibraryPrefs);
  const expandedModel = useEditorUiStore((s) => s.fixtureAddModelId);
  const [query, setQuery] = useState("");
  const [type, setType] = useState<TypeFilter>("all");

  useEffect(() => {
    if (status === "idle") void load();
  }, [status, load]);

  const typed = useMemo(() => models.map((m): Typed => ({ model: m, type: modelType(m) })), [models]);
  const byId = useMemo(() => new Map(typed.map((x) => [x.model.id, x])), [typed]);
  const q = query.trim().toLowerCase();
  const searched = typed.filter((x) => matches(x.model, q));
  const counts = new Map<FixtureType, number>();
  for (const x of searched) counts.set(x.type, (counts.get(x.type) ?? 0) + 1);
  const visible = type === "all" ? searched : searched.filter((x) => x.type === type);
  const filtering = q !== "" || type !== "all";

  if (status === "error") {
    return (
      <div className="flex flex-col items-start gap-2 p-3 text-sm">
        <p role="alert" className="text-destructive">{t("editor.library.loadFailed")}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
          {t("fixtures.retry")}
        </Button>
      </div>
    );
  }
  if (models.length === 0) {
    return <EmptyHint>{status === "loading" ? t("common.loading") : t("editor.library.noFixtures")}</EmptyHint>;
  }

  const chips: { value: TypeFilter; count: number }[] = [
    { value: "all", count: searched.length },
    ...FIXTURE_TYPES.filter((ft) => counts.has(ft)).map((ft) => ({ value: ft, count: counts.get(ft) ?? 0 })),
  ];
  const compact = prefs.density === "compact";
  const isOpen = (key: FixtureLibrarySection, items: readonly Typed[]) =>
    filtering || !prefs.collapsed.includes(key) || items.some((x) => x.model.id === expandedModel);
  const toggle = (key: FixtureLibrarySection) =>
    void setPrefs({
      collapsed: prefs.collapsed.includes(key) ? prefs.collapsed.filter((k) => k !== key) : [...prefs.collapsed, key],
    });

  const favorites = filtering ? [] : pickByIds(byId, prefs.favorites);
  const recent = filtering ? [] : pickByIds(byId, prefs.recent);
  const groups = FIXTURE_TYPES.map((ft) => ({ type: ft, items: visible.filter((x) => x.type === ft) })).filter((g) => g.items.length > 0);

  const renderCards = (items: readonly Typed[], section: string, batch: boolean) =>
    items.map((x) => (
      <FixtureModelCard key={x.model.id} model={x.model} type={x.type} section={section} density={prefs.density} batch={batch} />
    ));

  return (
    <div data-tour="fixture-add" className="flex flex-col">
      {/* 吸顶的工具区：列表滚动时搜索和筛选始终可用 */}
      <div className="sticky top-0 z-10 grid gap-1.5 border-b border-border/60 bg-surface-2/95 px-2 pt-2 pb-1.5 backdrop-blur-sm">
        <div className="flex items-center gap-1">
          <div className="relative min-w-0 flex-1">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              aria-label={t("editor.fixtureAdd.search")}
              placeholder={t("editor.fixtureAdd.search")}
              className="h-8 pr-7 pl-7 text-xs [&::-webkit-search-cancel-button]:appearance-none"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && query) {
                  e.preventDefault();
                  setQuery("");
                }
              }}
            />
            {query && (
              <button
                type="button"
                aria-label={t("editor.fixtureAdd.clearSearch")}
                onClick={() => setQuery("")}
                className="absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X aria-hidden className="size-3.5" />
              </button>
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 shrink-0"
            aria-pressed={compact}
            aria-label={t("editor.library.compact")}
            title={t("editor.library.compact")}
            onClick={() => void setPrefs({ density: compact ? "comfortable" : "compact" })}
          >
            {compact ? <Rows3 aria-hidden /> : <Rows2 aria-hidden />}
          </Button>
        </div>

        <div role="group" aria-label={t("editor.fixtureAdd.typeFilter")} className="flex flex-wrap gap-1">
          {chips.map((c) => (
            <button
              key={c.value}
              type="button"
              aria-pressed={type === c.value}
              onClick={() => setType(c.value)}
              className={cn(
                "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                type === c.value
                  ? "border-primary bg-primary/15 text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {c.value !== "all" && <FixtureTypeIcon type={c.value} labelled={false} className="size-3" />}
              {c.value === "all" ? t("editor.fixtureAdd.all") : t(`fixtures.type.${c.value}`)}
              <span className="num text-muted-foreground">{c.count}</span>
            </button>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-3 py-8 text-center text-xs text-muted-foreground">
          <Search aria-hidden className="size-6 opacity-60" />
          <p>{t("editor.fixtureAdd.noMatch")}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => {
              setQuery("");
              setType("all");
            }}
          >
            {t("editor.fixtureAdd.clearFilters")}
          </Button>
        </div>
      ) : (
        <div className={cn("flex flex-col p-2", compact ? "gap-2" : "gap-3")}>
          {favorites.length > 0 && (
            <LibrarySection
              title={t("editor.library.favorites")}
              icon={<Star aria-hidden className="size-3.5 fill-current text-warning" />}
              count={favorites.length}
              open={isOpen("favorites", [])}
              onToggle={() => toggle("favorites")}
              compact={compact}
            >
              {renderCards(favorites, "favorites", false)}
            </LibrarySection>
          )}
          {recent.length > 0 && (
            <LibrarySection
              title={t("editor.library.recent")}
              icon={<History aria-hidden className="size-3.5" />}
              count={recent.length}
              open={isOpen("recent", [])}
              onToggle={() => toggle("recent")}
              compact={compact}
            >
              {renderCards(recent, "recent", false)}
            </LibrarySection>
          )}
          {/* 全部模型按类型分组（收藏 / 最近只是快捷入口，模型仍在这里） */}
          <div role="group" aria-label={t("editor.fixtureAdd.list")} className={cn("flex flex-col", compact ? "gap-2" : "gap-3")}>
            {groups.map((g) => (
              <LibrarySection
                key={g.type}
                title={t(`fixtures.type.${g.type}`)}
                icon={<FixtureTypeIcon type={g.type} labelled={false} className="size-3.5" />}
                count={g.items.length}
                open={isOpen(g.type, g.items)}
                onToggle={() => toggle(g.type)}
                disabled={filtering}
                compact={compact}
              >
                {renderCards(g.items, "type", true)}
              </LibrarySection>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface LibrarySectionProps {
  title: string;
  icon: ReactNode;
  count: number;
  open: boolean;
  onToggle: () => void;
  /** 搜索 / 筛选时分组固定展开，折叠按钮不可用 */
  disabled?: boolean;
  compact: boolean;
  children: ReactNode;
}

/** 可折叠的分区：标题行（箭头、图标、名称、数量）+ 卡片列表。 */
function LibrarySection({ title, icon, count, open, onToggle, disabled, compact, children }: LibrarySectionProps) {
  const listId = useId();
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={disabled}
        onClick={onToggle}
        className={cn(
          "flex h-6 w-full items-center gap-1.5 rounded-md px-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase",
          "hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:text-muted-foreground",
        )}
      >
        <ChevronRight aria-hidden className={cn("size-3.5 transition-transform motion-reduce:transition-none", open && "rotate-90")} />
        {icon}
        <span className="truncate">{title}</span>
        <span className="num ml-auto rounded-full bg-muted px-1.5 text-[10px] leading-4">{count}</span>
      </button>
      {open && (
        <ul id={listId} aria-label={title} className={cn("mt-1 flex flex-col", compact ? "gap-0.5" : "gap-1")}>
          {children}
        </ul>
      )}
    </div>
  );
}

/** 拖动时跟随指针的模型小卡片。 */
export function FixtureModelChip({ name, type }: { name: string; type: FixtureType }) {
  return (
    <div className="flex items-center gap-1.5 rounded-md border border-primary bg-card px-2 py-1 text-xs font-medium shadow-lg">
      <FixtureTypeIcon type={type} labelled={false} className="text-clip-light" />
      {name}
    </div>
  );
}

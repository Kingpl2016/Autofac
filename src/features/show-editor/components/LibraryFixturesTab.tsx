import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDraggable } from "@dnd-kit/core";
import { ChevronDown, GripVertical, Plus, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  channelCount,
  FIXTURE_TYPES,
  FixtureTypeIcon,
  modelType,
  useFixtureStore,
  type FixtureModel,
  type FixtureType,
} from "@/features/fixtures";
import { cn } from "@/lib/utils";
import { addModelToShow } from "../hooks/fixtureAddActions";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { EmptyHint } from "./EmptyHint";
import { FixtureAddPanel } from "./FixtureAddPanel";

/** 从左侧灯具页拖出的模型（可放到 Patch 的 Universe 卡片、舞台监视器或时间线）。 */
export interface FixtureModelDragData {
  kind: "fixtureModel";
  modelId: string;
  name: string;
  type: FixtureType;
}

/** 类型筛选：全部或某一类。 */
type TypeFilter = "all" | FixtureType;

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

/**
 * 素材库的“灯具”标签页：搜索、按类型筛选灯具模型；
 * 每张卡片可拖到 Patch / 舞台 / 时间线，“+”快速加 1 台，展开后批量添加（带实时地址预览）。
 * 新灯具自动分配 DMX 地址、各自生成一条轨道，并被选中以便立刻编组或改名。
 */
export function LibraryFixturesTab() {
  const { t } = useTranslation();
  const models = useFixtureStore((s) => s.models);
  const status = useFixtureStore((s) => s.status);
  const load = useFixtureStore((s) => s.load);
  const [query, setQuery] = useState("");
  const [type, setType] = useState<TypeFilter>("all");

  useEffect(() => {
    if (status === "idle") void load();
  }, [status, load]);

  const typed = useMemo(() => models.map((m) => ({ model: m, type: modelType(m) })), [models]);
  const q = query.trim().toLowerCase();
  const searched = typed.filter((x) => matches(x.model, q));
  const counts = new Map<FixtureType, number>();
  for (const x of searched) counts.set(x.type, (counts.get(x.type) ?? 0) + 1);
  const visible = type === "all" ? searched : searched.filter((x) => x.type === type);

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

  return (
    <div data-tour="fixture-add" className="flex flex-col gap-2 p-2">
      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          aria-label={t("editor.fixtureAdd.search")}
          placeholder={t("editor.fixtureAdd.search")}
          className="h-8 pr-7 pl-7 text-xs"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
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

      {visible.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-3 py-6 text-center text-xs text-muted-foreground">
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
        <ul className="flex flex-col gap-1" aria-label={t("editor.fixtureAdd.list")}>
          {visible.map((x) => (
            <ModelCard key={x.model.id} model={x.model} type={x.type} />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * 一个灯具模型：左侧把手可拖，“+”快速加 1 台，展开按钮打开批量添加面板。
 */
function ModelCard({ model, type }: { model: FixtureModel; type: FixtureType }) {
  const { t } = useTranslation();
  const panelId = useId();
  const itemRef = useRef<HTMLLIElement>(null);
  const expanded = useEditorUiStore((s) => s.fixtureAddModelId === model.id);
  const setExpanded = useEditorUiStore((s) => s.setFixtureAddModel);
  const data: FixtureModelDragData = { kind: "fixtureModel", modelId: model.id, name: model.name, type };
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({ id: `fixtureModel:${model.id}`, data });
  const modes = 1 + (model.modes?.length ?? 0);
  // 展开时（包括从灯具素材库跳转过来）把卡片滚到可见处
  useEffect(() => {
    if (expanded) itemRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [expanded]);
  const meta = [
    t(`fixtures.type.${type}`),
    model.manufacturer || null,
    t("fixtures.list.channels", { count: channelCount(model) }),
    modes > 1 ? t("editor.fixtureAdd.modes", { count: modes }) : null,
  ].filter(Boolean);

  return (
    <li
      ref={itemRef}
      data-model-id={model.id}
      className={cn(
        "rounded-md border bg-card transition-colors",
        expanded ? "border-primary/60" : "border-border hover:border-muted-foreground/40",
      )}
    >
      <div className="flex items-center gap-1.5 py-1.5 pr-1 pl-1">
        <button
          ref={setNodeRef}
          type="button"
          {...listeners}
          {...attributes}
          aria-label={t("editor.fixtureAdd.drag", { name: model.name })}
          title={t("editor.fixtureAdd.drag", { name: model.name })}
          className={cn(
            "group flex h-8 shrink-0 cursor-grab items-center gap-0.5 rounded-md pr-1 text-muted-foreground hover:bg-accent active:cursor-grabbing",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            isDragging && "opacity-40",
          )}
        >
          <GripVertical aria-hidden className="size-3 opacity-50 group-hover:opacity-100" />
          <span className="flex size-7 items-center justify-center rounded-md bg-surface-2 text-clip-light">
            <FixtureTypeIcon type={type} labelled={false} className="size-4" />
          </span>
        </button>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm leading-tight font-medium" title={model.name}>
            {model.name}
          </span>
          <span className="num block truncate text-[11px] leading-tight text-muted-foreground" title={model.id}>
            {meta.join(" · ")}
          </span>
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label={t("editor.library.addAria", { name: model.name, count: 1 })}
          title={t("editor.library.addAria", { name: model.name, count: 1 })}
          onClick={() => addModelToShow(model, { count: 1 })}
        >
          <Plus aria-hidden />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-expanded={expanded}
          aria-controls={expanded ? panelId : undefined}
          aria-label={t("editor.fixtureAdd.batch", { name: model.name })}
          title={t("editor.fixtureAdd.batch", { name: model.name })}
          onClick={() => setExpanded(expanded ? null : model.id)}
        >
          <ChevronDown aria-hidden className={cn("transition-transform motion-reduce:transition-none", expanded && "rotate-180")} />
        </Button>
      </div>
      {expanded && <FixtureAddPanel id={panelId} model={model} />}
    </li>
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

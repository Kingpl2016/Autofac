import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ChevronRight, Crosshair, Search, X } from "lucide-react";

import { FixtureTypeIcon, modelType, type FixtureModel, type FixtureType } from "@/features/fixtures";
import { cn } from "@/lib/utils";
import { Segmented } from "@/shared/components/Segmented";
import { headsOf, refOf } from "../lib/fixtureRef";
import { hasProblem, type PatchStatus } from "../lib/patch";
import type { FixtureInstance } from "../lib/project";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { usePlaybackStore } from "../stores/usePlaybackStore";

/** 列表筛选：全部，或只看地址有问题的。 */
type ListFilter = "all" | "problems";

interface FixtureListProps {
  fixtures: readonly FixtureInstance[];
  models: readonly FixtureModel[];
  status: ReadonlyMap<string, PatchStatus>;
  /** 当前选中的灯具与像素引用（已按工程过滤） */
  selected: readonly string[];
}

/**
 * “灯具与 Patch”的灯具列表（grandMA3 Patch 式的紧凑行）：类型图标、名称、型号、Universe.通道范围、状态。
 *
 * - 单击单选，Ctrl / ⌘ 追加或取消，Shift 从上次点选的灯具连选；
 * - 多头 / 像素灯可以展开出像素行，像素和灯具一样可以选中（选中的是像素引用 `灯具id#n`）；
 * - 键盘：↑ / ↓ 移动（Shift 扩展选择），→ 展开像素、← 收起，空格切换选中，Ctrl+A 全选可见的灯具，Esc 取消选择；
 * - 悬停与舞台、Universe 视图共享高亮；
 * - 收到“在 Patch 中定位”的请求时滚动到第一台（被搜索 / 筛选挡住时先清掉筛选）。
 */
export function FixtureList({ fixtures, models, status, selected }: FixtureListProps) {
  const { t } = useTranslation();
  const setSelected = useEditorUiStore((s) => s.setSelectedFixtures);
  const hoverId = useEditorUiStore((s) => s.hoverFixtureId);
  const setHover = useEditorUiStore((s) => s.setHoverFixture);
  const reveal = useEditorUiStore((s) => s.revealRequest);
  const locateId = usePlaybackStore((s) => s.state?.locate ?? null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ListFilter>("all");
  const [active, setActive] = useState<string | null>(null);
  const anchor = useRef<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const modelById = useMemo(() => new Map(models.map((m) => [m.id, m])), [models]);
  const typeOf = useMemo(() => {
    const cache = new Map<string, FixtureType>();
    for (const m of models) cache.set(m.id, modelType(m));
    return cache;
  }, [models]);
  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      fixtures.filter((f) => {
        if (filter === "problems" && !hasProblem(status.get(f.id))) return false;
        if (!q) return true;
        const model = modelById.get(f.modelId);
        return [f.name, model?.name ?? "", f.modelId, `${f.universe}.${f.address}`].some((s) => s.toLowerCase().includes(q));
      }),
    [fixtures, filter, q, status, modelById],
  );
  const problems = useMemo(() => fixtures.filter((f) => hasProblem(status.get(f.id))).length, [fixtures, status]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const allSelected = fixtures.length > 0 && fixtures.every((f) => selectedSet.has(f.id));
  // 多头 / 像素灯可以展开出像素行（像素引用 `灯具id#n`），像素可以单独选中、建组、建轨道
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const headsByFixture = useMemo(
    () => new Map(fixtures.map((f) => [f.id, headsOf(modelById.get(f.modelId), f.modeId)])),
    [fixtures, modelById],
  );
  const rows = useMemo(
    () =>
      visible.flatMap((f) => [
        { id: f.id, fixture: f, head: null as number | null },
        ...(expanded.has(f.id) ? (headsByFixture.get(f.id) ?? []).map((h) => ({ id: refOf(f.id, h), fixture: f, head: h as number | null })) : []),
      ]),
    [visible, expanded, headsByFixture],
  );
  const toggleExpanded = (id: string, open?: boolean) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (open ?? !next.has(id)) next.add(id);
      else next.delete(id);
      return next;
    });

  // “在 Patch 中定位”：收到新请求时（渲染阶段）把目标设为当前项，被搜索 / 筛选挡住时清掉筛选；
  // 渲染出来之后（effect）再滚动到它并消费掉请求
  const revealTarget = reveal?.ids.find((id) => fixtures.some((f) => f.id === id)) ?? null;
  const [seenReveal, setSeenReveal] = useState(reveal);
  if (reveal !== seenReveal) {
    setSeenReveal(reveal);
    if (revealTarget) {
      setActive(revealTarget);
      if (!visible.some((f) => f.id === revealTarget)) {
        setQuery("");
        setFilter("all");
      }
    }
  }
  useEffect(() => {
    if (!reveal) return;
    if (revealTarget && !visible.some((f) => f.id === revealTarget)) return;
    useEditorUiStore.setState({ revealRequest: null });
    if (!revealTarget) return;
    anchor.current = revealTarget;
    const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    rowOf(listRef.current, revealTarget)?.scrollIntoView?.({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [reveal, revealTarget, visible]);

  /** 指针点选：单选 / Ctrl 切换 / Shift 连选。 */
  const pick = (id: string, mode: "single" | "toggle" | "range") => {
    setActive(id);
    if (mode === "toggle") {
      setSelected(selectedSet.has(id) ? selected.filter((x) => x !== id) : [...selected, id]);
      anchor.current = id;
      return;
    }
    if (mode === "range" && anchor.current) {
      const ids = rows.map((r) => r.id);
      const a = ids.indexOf(anchor.current);
      const b = ids.indexOf(id);
      if (a >= 0 && b >= 0) {
        setSelected(ids.slice(Math.min(a, b), Math.max(a, b) + 1));
        return;
      }
    }
    setSelected([id]);
    anchor.current = id;
  };

  const onRowClick = (e: MouseEvent, id: string) => pick(id, e.shiftKey ? "range" : e.ctrlKey || e.metaKey ? "toggle" : "single");

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const ids = rows.map((r) => r.id);
    if (ids.length === 0) return;
    const i = active ? ids.indexOf(active) : -1;
    const activeRow = i >= 0 ? rows[i] : undefined;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const next = ids[Math.min(ids.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)))] ?? ids[0];
      pick(next, e.shiftKey ? "range" : "single");
      rowOf(listRef.current, next)?.scrollIntoView?.({ block: "nearest" });
    } else if (e.key === "ArrowRight" && activeRow?.head === null && (headsByFixture.get(activeRow.id)?.length ?? 0) > 0) {
      toggleExpanded(activeRow.id, true);
    } else if (e.key === "ArrowLeft" && activeRow) {
      // 在像素行上按 ← 回到所属灯具行；在灯具行上收起
      if (activeRow.head !== null) setActive(activeRow.fixture.id);
      else toggleExpanded(activeRow.id, false);
    } else if (e.key === " " && active) {
      pick(active, "toggle");
    } else if (e.key.toLowerCase() === "a" && (e.ctrlKey || e.metaKey)) {
      setSelected(visible.map((f) => f.id));
    } else if (e.key === "Escape") {
      setSelected([]);
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-border p-2">
        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            aria-label={t("editor.patch.search")}
            placeholder={t("editor.patch.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className={cn(
              "h-7 w-full rounded-md border border-input bg-transparent pr-7 pl-7 text-xs",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
          />
          {query && (
            <button
              type="button"
              aria-label={t("editor.patch.clearSearch")}
              onClick={() => setQuery("")}
              className="absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X aria-hidden className="size-3.5" />
            </button>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <Segmented
            size="xs"
            ariaLabel={t("editor.patch.filter")}
            value={filter}
            onChange={(v) => setFilter(v)}
            options={[
              { value: "all", label: t("editor.patch.filterAll", { count: fixtures.length }) },
              { value: "problems", label: t("editor.patch.filterProblems", { count: problems }) },
            ]}
          />
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={allSelected}
              onChange={(e) => setSelected(e.target.checked ? fixtures.map((f) => f.id) : [])}
            />
            {t("editor.patch.selectAll")}
          </label>
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="flex flex-col items-center gap-2 p-4 text-center text-xs text-muted-foreground">
          <p>{t("editor.patch.noMatch")}</p>
          <button
            type="button"
            className="rounded-sm underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              setQuery("");
              setFilter("all");
            }}
          >
            {t("editor.patch.clearFilter")}
          </button>
        </div>
      ) : (
        <ul
          ref={listRef}
          role="listbox"
          aria-multiselectable
          aria-label={t("editor.patch.list")}
          aria-activedescendant={active && rows.some((r) => r.id === active) ? optionId(active) : undefined}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onPointerLeave={() => setHover(null)}
          className="@container min-h-0 flex-1 overflow-auto p-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          {rows.map((row) => {
            const f = row.fixture;
            if (row.head !== null) {
              const isSelected = selectedSet.has(row.id);
              return (
                <li
                  key={row.id}
                  id={optionId(row.id)}
                  role="option"
                  aria-selected={isSelected}
                  aria-label={`${f.name} · ${t("editor.patch.pixel", { n: row.head })}`}
                  data-fixture-id={row.id}
                  onClick={(e) => onRowClick(e, row.id)}
                  onPointerEnter={() => setHover(f.id)}
                  className={cn(
                    "relative flex h-7 cursor-default items-center gap-2 rounded-sm pr-2 pl-8 text-xs select-none",
                    isSelected ? "bg-primary/15 text-foreground" : "hover:bg-surface-3",
                    active === row.id && "outline outline-1 -outline-offset-1 outline-ring/60",
                  )}
                >
                  {isSelected && <span aria-hidden className="absolute inset-y-1 left-0.5 w-0.5 rounded-full bg-primary" />}
                  <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-muted-foreground/60" />
                  <span className="min-w-0 flex-1 truncate">{t("editor.patch.pixel", { n: row.head })}</span>
                </li>
              );
            }
            const heads = headsByFixture.get(f.id) ?? [];
            const open = expanded.has(f.id);
            const s = status.get(f.id);
            const isSelected = selectedSet.has(f.id);
            const problem = hasProblem(s);
            const model = modelById.get(f.modelId);
            const reasons = [
              (s?.conflictsWith.length ?? 0) > 0 && t("editor.patch.conflict", { count: s?.conflictsWith.length ?? 0 }),
              s?.overflow && t("editor.patch.overflow"),
              s?.missingModel && t("editor.patch.missingModel"),
            ].filter((x): x is string => typeof x === "string");
            const range = s?.range ? `${s.range.universe}.${s.range.start}–${s.range.end}` : `${f.universe}.${f.address}`;
            const mirrors = f.mirrors?.length ?? 0;
            return (
              <li
                key={f.id}
                id={optionId(f.id)}
                role="option"
                aria-selected={isSelected}
                aria-label={f.name}
                aria-description={[model?.name ?? f.modelId, range, ...reasons].join(" · ")}
                data-fixture-id={f.id}
                onClick={(e) => onRowClick(e, f.id)}
                onPointerEnter={() => setHover(f.id)}
                className={cn(
                  "relative flex h-8 cursor-default items-center gap-2 rounded-sm pr-2 pl-2.5 text-xs select-none",
                  isSelected ? "bg-primary/15 text-foreground" : "hover:bg-surface-3",
                  !isSelected && hoverId === f.id && "bg-accent",
                  active === f.id && "outline outline-1 -outline-offset-1 outline-ring/60",
                )}
              >
                {isSelected && <span aria-hidden className="absolute inset-y-1 left-0.5 w-0.5 rounded-full bg-primary" />}
                {heads.length > 0 ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-expanded={open}
                    aria-label={t(open ? "editor.patch.collapsePixels" : "editor.patch.expandPixels", { name: f.name, count: heads.length })}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleExpanded(f.id);
                    }}
                    className="-ml-1 flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <ChevronRight aria-hidden className={cn("size-3.5 transition-transform motion-reduce:transition-none", open && "rotate-90")} />
                  </button>
                ) : null}
                <FixtureTypeIcon type={typeOf.get(f.modelId) ?? "other"} labelled={false} className="text-clip-light" />
                <span className="min-w-0 flex-1 truncate font-medium" title={f.name}>
                  {f.name}
                </span>
                <span className="hidden max-w-28 truncate text-muted-foreground @[18rem]:inline" title={model?.name ?? f.modelId}>
                  {model?.name ?? f.modelId}
                </span>
                <span className="num shrink-0 text-muted-foreground">{range}</span>
                {mirrors > 0 && <span className="num shrink-0 rounded-sm bg-surface-3 px-1 text-[10px] text-muted-foreground">+{mirrors}</span>}
                {locateId === f.id && <Crosshair aria-hidden className="size-3.5 shrink-0 text-primary" />}
                {problem && (
                  <span className="flex shrink-0 text-destructive" title={reasons.join("；")}>
                    <AlertTriangle aria-hidden className="size-3.5" />
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * 找到列表里某台灯具的行（按 `data-fixture-id` 比较，不拼选择器，id 里有特殊字符也没问题）。
 *
 * @param list 列表元素。
 * @param fixtureId 灯具 id。
 * @returns 行元素；不在列表里时为 `undefined`。
 */
function rowOf(list: HTMLElement | null, fixtureId: string): HTMLElement | undefined {
  return Array.from(list?.querySelectorAll<HTMLElement>("[data-fixture-id]") ?? []).find((x) => x.dataset.fixtureId === fixtureId);
}

/**
 * 列表项的 DOM id（`aria-activedescendant` 用）。
 *
 * @param fixtureId 灯具 id。
 * @returns 元素 id。
 */
function optionId(fixtureId: string): string {
  return `patch-fixture-${fixtureId}`;
}

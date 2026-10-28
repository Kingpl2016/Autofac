import { useMemo, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { CheckSquare, ChevronDown, ChevronRight, LayoutGrid, Rows3, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Segmented } from "@/shared/components/Segmented";
import { DMX_CHANNELS, type Rgb } from "../lib/project";
import { pickSwatch, swatchSections, visibleOrder, type SwatchItem, type SwatchSection } from "../lib/swatchGroups";
import {
  SWATCH_DENSITIES,
  SWATCH_GROUP_BY,
  useEditorPrefsStore,
  type SwatchDensity,
  type SwatchGroupBy,
} from "../stores/useEditorPrefsStore";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProgrammerStore } from "../stores/useProgrammerStore";
import { useProjectStore } from "../stores/useProjectStore";

/** 色块网格：舒适为 4.5rem 的块（带名称与地址），紧凑为 2.25rem 的小块。 */
const GRID: Record<SwatchDensity, string> = {
  comfortable: "grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))] gap-2",
  compact: "grid-cols-[repeat(auto-fill,minmax(2.25rem,1fr))] gap-1",
};

/** 颜色写成 CSS 变量的值（数据色，运行时拼接）。 */
const rgbCss = ([r, g, b]: Rgb) => `rgb(${r} ${g} ${b})`;

/**
 * 预览区的色块视图：每台灯具一个色块（播放头处的实际颜色 + 底部强度条）。
 *
 * - 默认按 Universe 分区：区头吸顶，显示 U 编号、名称与颜色、占用 n/512、灯具数与冲突数，可折叠、可一键选中本区；
 *   区内按起始地址排列，色块下标出 `@地址`；也可以按灯具分组或按型号分区。
 * - 冲突的灯具画红框，有镜像地址的画斜纹角标，编程器里有值的画圆点（图例在顶部）。
 * - 点选：单击单选，Ctrl / ⌘ 追加或取消，Shift 按屏幕上的顺序连选；与编程器、Patch 面板共用选择。
 * - 悬停时与舞台监视器、Universe 卡片互相高亮（`hoverFixtureId`）。
 *
 * @param props.colors 每台灯具在播放头处的颜色（已乘强度）。
 */
export function SwatchView({ colors }: { colors: ReadonlyMap<string, Rgb> }) {
  const { t } = useTranslation();
  const fixtures = useProjectStore((s) => s.project.fixtures);
  const fixtureModels = useProjectStore((s) => s.project.fixtureModels);
  const groups = useProjectStore((s) => s.project.groups);
  const universes = useProjectStore((s) => s.project.output.universes);
  const selectedIds = useEditorUiStore((s) => s.selectedFixtureIds);
  const setSelected = useEditorUiStore((s) => s.setSelectedFixtures);
  const hover = useEditorUiStore((s) => s.hoverFixtureId);
  const setHover = useEditorUiStore((s) => s.setHoverFixture);
  const values = useProgrammerStore((s) => s.values);
  const groupBy = useEditorPrefsStore((s) => s.swatchGroupBy);
  const setGroupBy = useEditorPrefsStore((s) => s.setSwatchGroupBy);
  const density = useEditorPrefsStore((s) => s.swatchDensity);
  const setDensity = useEditorPrefsStore((s) => s.setSwatchDensity);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const anchor = useRef<string | null>(null);

  const sections = useMemo(
    () => swatchSections({ fixtures, fixtureModels, groups, output: { universes } }, groupBy),
    [fixtures, fixtureModels, groups, universes, groupBy],
  );
  const order = useMemo(() => visibleOrder(sections, collapsed), [sections, collapsed]);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const compact = density === "compact";

  const pick = (id: string, e: MouseEvent) => {
    const toggle = e.ctrlKey || e.metaKey;
    setSelected(pickSwatch(order, selectedIds, anchor.current, id, { shift: e.shiftKey, toggle }));
    if (!e.shiftKey) anchor.current = id;
  };
  const toggleSection = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const titleOf = (s: SwatchSection) => {
    if (s.ungrouped) return t("editor.swatches.ungrouped");
    return s.subtitle && groupBy === "universe" ? `${s.title} · ${s.subtitle}` : s.title;
  };

  const swatch = (it: SwatchItem, sectionKey: string) => {
    const rgb = colors.get(it.fixtureId) ?? [0, 0, 0];
    const [r, g, b] = rgb;
    const level = Math.max(r, g, b) / 255;
    const isSelected = selected.has(it.fixtureId);
    const programmed = values[it.fixtureId] !== undefined;
    const mirrorText = it.mirrors.map((m) => `U${m.universe} @${m.address}`).join("、");
    const detail = [
      `${it.name} · U${it.universe} @${it.address}–${it.end}`,
      it.mirrors.length > 0 ? t("editor.swatches.mirrorTo", { targets: mirrorText }) : null,
      it.conflict ? t("editor.swatches.conflict") : null,
      programmed ? t("editor.preview.inProgrammer") : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <li key={`${sectionKey}:${it.fixtureId}`} className="min-w-0" title={detail}>
        <button
          type="button"
          aria-pressed={isSelected}
          aria-label={`${t("editor.preview.swatch", { name: it.name, r, g, b })}，${t("editor.swatches.address", {
            universe: it.universe,
            address: it.address,
          })}${it.conflict ? `，${t("editor.swatches.conflict")}` : ""}`}
          onClick={(e) => pick(it.fixtureId, e)}
          onPointerEnter={() => setHover(it.fixtureId)}
          data-fixture-id={it.fixtureId}
          className={cn(
            "relative block w-full cursor-pointer overflow-hidden rounded-md border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            compact ? "h-6" : "h-10",
            it.conflict ? "border-destructive ring-1 ring-destructive" : "border-border",
            isSelected && "border-primary ring-2 ring-primary/60",
            hover === it.fixtureId && !isSelected && "outline outline-2 outline-offset-1 outline-foreground/60",
          )}
          style={{ backgroundColor: rgbCss(rgb) }}
        >
          {/* 强度条：颜色里最亮的分量，暗色也能看出亮度 */}
          <span aria-hidden className="absolute inset-x-0 bottom-0 h-1 bg-background/60">
            <span className="block h-full bg-foreground/80" style={{ width: `${Math.round(level * 100)}%` }} />
          </span>
          {it.mirrors.length > 0 && (
            <span
              aria-hidden
              data-testid="swatch-mirror"
              className="absolute left-0 top-0 size-3 bg-[repeating-linear-gradient(-45deg,var(--foreground)_0_1px,transparent_1px_3px)] opacity-70"
            />
          )}
          {programmed && <span aria-hidden className="absolute right-1 top-1 size-1.5 rounded-full bg-keyframe" />}
        </button>
        {!compact && (
          <p className="mt-1 flex min-w-0 items-baseline justify-center gap-1 text-[11px] text-muted-foreground">
            <span className="truncate">{it.name}</span>
            <span className="num shrink-0 text-[10px] opacity-80">@{it.address}</span>
          </p>
        )}
      </li>
    );
  };

  return (
    <div className="grid gap-2" onPointerLeave={() => setHover(null)}>
      <div data-tour="preview-swatch-tools" className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Segmented<SwatchGroupBy>
          size="xs"
          ariaLabel={t("editor.swatches.groupBy")}
          value={groupBy}
          options={SWATCH_GROUP_BY.map((v) => ({ value: v, label: t(`editor.swatches.by.${v}`) }))}
          onChange={setGroupBy}
        />
        <Segmented<SwatchDensity>
          size="xs"
          ariaLabel={t("editor.swatches.density")}
          value={density}
          options={SWATCH_DENSITIES.map((v) => ({
            value: v,
            label: t(`editor.swatches.densities.${v}`),
            icon: v === "comfortable" ? <LayoutGrid aria-hidden /> : <Rows3 aria-hidden />,
            labelClassName: "sr-only",
            title: t(`editor.swatches.densities.${v}`),
          }))}
          onChange={setDensity}
        />
        <p
          aria-label={t("editor.swatches.legend")}
          className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-muted-foreground"
        >
          <span className="flex items-center gap-1">
            <span aria-hidden className="size-1.5 rounded-full bg-keyframe" />
            {t("editor.swatches.legendProgrammed")}
          </span>
          <span className="flex items-center gap-1">
            <span aria-hidden className="size-2.5 rounded-[2px] border border-destructive ring-1 ring-destructive" />
            {t("editor.swatches.legendConflict")}
          </span>
          <span className="flex items-center gap-1">
            <span
              aria-hidden
              className="size-2.5 rounded-[2px] border border-border bg-[repeating-linear-gradient(-45deg,var(--foreground)_0_1px,transparent_1px_3px)]"
            />
            {t("editor.swatches.legendMirror")}
          </span>
          <span className="flex items-center gap-1">
            <span aria-hidden className="h-1 w-3 rounded-full bg-foreground/80" />
            {t("editor.swatches.legendLevel")}
          </span>
        </p>
      </div>

      {sections.map((s) => {
        const open = !collapsed.has(s.key);
        const title = titleOf(s);
        return (
          <section key={s.key} aria-label={title} className="grid gap-1.5">
            <header
              className="sticky top-0 z-10 flex items-center gap-1.5 rounded-md border border-border bg-surface-2/95 px-1.5 py-1 backdrop-blur-sm"
            >
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-5 [&_svg]:size-3.5"
                aria-expanded={open}
                aria-label={t(open ? "editor.universe.collapse" : "editor.universe.expand", { name: title })}
                onClick={() => toggleSection(s.key)}
              >
                {open ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
              </Button>
              <span
                aria-hidden
                className={cn("h-3.5 w-1 shrink-0 rounded-full", s.color ? "bg-(--sec)" : "bg-border")}
                style={s.color ? ({ "--sec": rgbCss(s.color) } as CSSProperties) : undefined}
              />
              <h4 className="min-w-0 truncate text-xs font-medium">{title}</h4>
              <span className="text-[11px] text-muted-foreground">{t("editor.universe.fixtures", { count: s.items.length })}</span>
              {s.conflicts > 0 && (
                <span className="flex items-center gap-0.5 text-[11px] font-medium text-destructive">
                  <TriangleAlert className="size-3" aria-hidden />
                  {t("editor.universe.conflicts", { count: s.conflicts })}
                </span>
              )}
              <span className="ml-auto flex items-center gap-1">
                {s.used !== null && (
                  <span
                    className={cn("num text-[11px]", s.used / DMX_CHANNELS >= 0.9 ? "text-warning" : "text-muted-foreground")}
                    title={t("editor.swatches.usage", { used: s.used, total: DMX_CHANNELS })}
                  >
                    {s.used}/{DMX_CHANNELS}
                  </span>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-5 [&_svg]:size-3.5"
                  aria-label={t("editor.swatches.selectSection", { name: title })}
                  title={t("editor.swatches.selectSection", { name: title })}
                  onClick={() => setSelected(s.items.map((it) => it.fixtureId))}
                >
                  <CheckSquare aria-hidden />
                </Button>
              </span>
            </header>
            {open && (
              <ul aria-label={t("editor.preview.swatches", { count: s.items.length })} className={cn("grid", GRID[density])}>
                {s.items.map((it) => swatch(it, s.key))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

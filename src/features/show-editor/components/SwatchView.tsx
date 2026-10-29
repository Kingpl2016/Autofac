import {
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { useDraggable } from "@dnd-kit/core";
import {
  CheckSquare,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Crosshair,
  LayoutGrid,
  Rows3,
  Search,
  Square,
  TriangleAlert,
  X,
  Zap,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Segmented } from "@/shared/components/Segmented";
import { announce } from "@/shared/stores/announcerStore";
import { revealInPatch } from "../hooks/selectionActions";
import { toggleLocate } from "../hooks/transportActions";
import { baseOf, headsOf, pixelRefsOf, refOf } from "../lib/fixtureRef";
import { ensureRefTracks } from "../lib/ops";
import { knockout } from "../lib/programmer";
import { DMX_CHANNELS, type Rgb } from "../lib/project";
import {
  filterSwatchSections,
  pickSwatch,
  strobingFixtures,
  SWATCH_FILTERS,
  SWATCH_LABELS,
  swatchLabelText,
  swatchSections,
  visibleOrder,
  type SwatchFilter,
  type SwatchItem,
  type SwatchLabel,
  type SwatchSection,
  type SwatchSort,
} from "../lib/swatchGroups";
import { placeFixtures } from "../stage/stageGeometry";
import { marqueeHits } from "../timeline/dragModel";
import {
  SWATCH_DENSITIES,
  SWATCH_GROUP_BY,
  useEditorPrefsStore,
  type SwatchDensity,
  type SwatchGroupBy,
} from "../stores/useEditorPrefsStore";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { usePlaybackStore } from "../stores/usePlaybackStore";
import { useProgrammerStore } from "../stores/useProgrammerStore";
import { useProjectStore } from "../stores/useProjectStore";
import { HelpTip } from "./HelpTip";

/** 色块网格：大为 7rem 的块（像素分段看得清），舒适为 4.5rem（带名称与地址），紧凑为 2.25rem 的小块。 */
const GRID: Record<SwatchDensity, string> = {
  large: "grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2",
  comfortable: "grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))] gap-2",
  compact: "grid-cols-[repeat(auto-fill,minmax(2.25rem,1fr))] gap-1",
};
/** 色块高度。 */
const HEIGHT: Record<SwatchDensity, string> = { large: "h-16", comfortable: "h-10", compact: "h-6" };
/** 像素多于这么多时只画渐变条、不能逐个点选。 */
const MAX_PIXEL_SEGMENTS = 64;

/** 拖到时间线上建轨道的数据。 */
export interface FixtureInstanceDragData {
  kind: "fixtureInstance";
  /** 灯具或像素引用 */
  refs: string[];
  /** 拖拽浮层上的名称 */
  name: string;
}

/** 颜色写成 CSS 变量的值（数据色，运行时拼接）。 */
const rgbCss = ([r, g, b]: Rgb) => `rgb(${r} ${g} ${b})`;

/** 进行中的框选（相对色块区的客户端坐标）。 */
interface Marquee {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  additive: boolean;
  base: string[];
  active: boolean;
}

interface SwatchViewProps {
  /** 每台灯具（以及像素 `id#n`）在播放头处的颜色（已乘强度） */
  colors: ReadonlyMap<string, Rgb>;
  /** 取某个 Universe 当前的 512 字节（频闪角标用）；省略时不判断频闪 */
  frameOf?: (universe: number) => ArrayLike<number> | null;
}

/**
 * 预览区的色块视图：每台灯具一个色块（播放头处的实际颜色 + 底部强度条）。
 *
 * - 分区：按 Universe（默认，区头显示占用、冲突，可折叠、可一键选中本区；折叠状态记住）、按灯具分组或按型号；
 *   区内可按地址或按舞台位置排列；
 * - 搜索名称 / 型号 / 地址（`@12`、`1.12`），筛选“选中 / 编程中 / 有冲突”；
 * - 标签可选名称、地址、强度百分比、HEX；三档大小；像素灯显示分段条，点某一段选中这个像素；
 * - 角标：编程器里有值（圆点）、冲突（红框）、镜像（斜纹）、频闪、通道锁定（P）、正在找灯；
 * - 选择：单击单选，Ctrl / ⌘ 追加或取消，Shift 按屏幕顺序连选，空白处拖动框选；
 *   方向键移动（Shift 扩展），Ctrl+A 全选可见，Esc 取消；右键菜单；拖到时间线为所选灯建轨道。
 *
 * @param props.colors 每台灯具在播放头处的颜色。
 * @param props.frameOf 取 Universe 当前数据（频闪角标）。
 */
export function SwatchView({ colors, frameOf }: SwatchViewProps) {
  const { t } = useTranslation();
  const project = useProjectStore((s) => s.project);
  const update = useProjectStore((s) => s.update);
  const { fixtures, fixtureModels, groups, stage } = project;
  const universes = project.output.universes;
  const park = project.output.park;
  const selectedIds = useEditorUiStore((s) => s.selectedFixtureIds);
  const setSelected = useEditorUiStore((s) => s.setSelectedFixtures);
  const hover = useEditorUiStore((s) => s.hoverFixtureId);
  const setHover = useEditorUiStore((s) => s.setHoverFixture);
  const values = useProgrammerStore((s) => s.values);
  const setValues = useProgrammerStore((s) => s.setValues);
  const locateId = usePlaybackStore((s) => s.state?.locate ?? null);
  const groupBy = useEditorPrefsStore((s) => s.swatchGroupBy);
  const setGroupBy = useEditorPrefsStore((s) => s.setSwatchGroupBy);
  const density = useEditorPrefsStore((s) => s.swatchDensity);
  const setDensity = useEditorPrefsStore((s) => s.setSwatchDensity);
  const label = useEditorPrefsStore((s) => s.swatchLabel);
  const setLabel = useEditorPrefsStore((s) => s.setSwatchLabel);
  const sort = useEditorPrefsStore((s) => s.swatchSort);
  const setSort = useEditorPrefsStore((s) => s.setSwatchSort);
  const collapsedKeys = useEditorPrefsStore((s) => s.swatchCollapsed);
  const setCollapsedKeys = useEditorPrefsStore((s) => s.setSwatchCollapsed);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SwatchFilter>("all");
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const [menuTarget, setMenuTarget] = useState<{ id: string; section: string } | null>(null);
  const anchor = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const positions = useMemo(() => (sort === "stage" ? placeFixtures(fixtures, stage) : undefined), [sort, fixtures, stage]);
  const sections = useMemo(
    () => swatchSections({ fixtures, fixtureModels, groups, output: { universes, park } }, groupBy, { sort, positions }),
    [fixtures, fixtureModels, groups, universes, park, groupBy, sort, positions],
  );
  // 像素引用归并到整灯：只选了像素、或编程器里只有像素的值时，整灯的色块也要有反应
  const selectedExact = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedBase = useMemo(() => new Set(selectedIds.map(baseOf)), [selectedIds]);
  const programmedBase = useMemo(() => new Set(Object.keys(values).map(baseOf)), [values]);
  const shown = useMemo(
    () => filterSwatchSections(sections, query, filter, { selected: selectedBase, programmed: programmedBase }),
    [sections, query, filter, selectedBase, programmedBase],
  );
  const collapsed = useMemo(() => new Set(collapsedKeys), [collapsedKeys]);
  const order = useMemo(() => visibleOrder(shown, collapsed), [shown, collapsed]);
  const heads = useMemo(() => {
    const models = new Map(fixtureModels.map((m) => [m.id, m]));
    return new Map(fixtures.map((f) => [f.id, headsOf(models.get(f.modelId), f.modeId)]));
  }, [fixtures, fixtureModels]);
  const strobing = frameOf ? strobingFixtures({ fixtures, fixtureModels }, frameOf) : new Set<string>();

  const pick = (id: string, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
    const toggle = e.ctrlKey || e.metaKey;
    setSelected(pickSwatch(order, selectedIds, anchor.current, id, { shift: e.shiftKey, toggle }));
    if (!e.shiftKey) anchor.current = id;
  };
  const pickPixel = (ref: string, e: MouseEvent) => {
    if (e.ctrlKey || e.metaKey) setSelected(selectedExact.has(ref) ? selectedIds.filter((x) => x !== ref) : [...selectedIds, ref]);
    else setSelected([ref]);
  };
  const toggleSection = (key: string) =>
    setCollapsedKeys(collapsed.has(key) ? collapsedKeys.filter((k) => k !== key) : [...collapsedKeys, key]);

  const titleOf = (s: SwatchSection) => {
    if (s.ungrouped) return t("editor.swatches.ungrouped");
    return s.subtitle && groupBy === "universe" ? `${s.title} · ${s.subtitle}` : s.title;
  };

  // ---- 键盘：方向键移动（上下按列数跳），Shift 扩展，Ctrl+A 全选可见，Esc 取消 ----
  const swatchButtons = () => Array.from(rootRef.current?.querySelectorAll<HTMLElement>("button[data-fixture-id]") ?? []);
  const focusSwatch = (id: string) => swatchButtons().find((b) => b.dataset.fixtureId === id)?.focus();
  const columnsOf = (el: HTMLElement): number => {
    const list = Array.from(el.closest("ul")?.querySelectorAll<HTMLElement>("button[data-fixture-id]") ?? []);
    const top = list[0]?.getBoundingClientRect().top ?? 0;
    return Math.max(1, list.filter((b) => Math.abs(b.getBoundingClientRect().top - top) < 2).length);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("button[data-fixture-id]");
    if (e.key === "Escape" && selectedIds.length > 0) {
      setSelected([]);
    } else if (e.key.toLowerCase() === "a" && (e.ctrlKey || e.metaKey) && el) {
      setSelected(order);
    } else if (el && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
      const i = order.indexOf(el.dataset.fixtureId ?? "");
      if (i < 0) return;
      const step = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : (e.key === "ArrowUp" ? -1 : 1) * columnsOf(el);
      const next = order[Math.min(order.length - 1, Math.max(0, i + step))];
      pick(next, { shiftKey: e.shiftKey, ctrlKey: false, metaKey: false });
      focusSwatch(next);
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  // ---- 框选：空白处拖动 ----
  const local = (e: { clientX: number; clientY: number }) => {
    const r = rootRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button, input, header, [role='radiogroup'], [role='combobox'], [data-swatch-tools]")) return;
    const p = local(e);
    setMarquee({ x0: p.x, y0: p.y, x1: p.x, y1: p.y, additive: e.ctrlKey || e.metaKey || e.shiftKey, base: selectedIds, active: false });
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!marquee) return;
    const p = local(e);
    if (!marquee.active && Math.hypot(p.x - marquee.x0, p.y - marquee.y0) < 4) return;
    const next = { ...marquee, x1: p.x, y1: p.y, active: true };
    setMarquee(next);
    const root = rootRef.current?.getBoundingClientRect();
    const rect = {
      left: Math.min(next.x0, next.x1) + (root?.left ?? 0),
      top: Math.min(next.y0, next.y1) + (root?.top ?? 0),
      width: Math.abs(next.x1 - next.x0),
      height: Math.abs(next.y1 - next.y0),
    };
    const hits = marqueeHits(
      swatchButtons().map((b) => {
        const r = b.getBoundingClientRect();
        return { id: b.dataset.fixtureId ?? "", left: r.left, top: r.top, width: r.width, height: r.height };
      }),
      rect,
    );
    setSelected(next.additive ? [...new Set([...next.base, ...hits])] : [...new Set(hits)]);
  };
  const onPointerUp = () => setMarquee(null);

  // ---- 右键菜单 ----
  const menuIds = menuTarget ? (selectedBase.has(menuTarget.id) ? [...selectedBase] : [menuTarget.id]) : [];
  const menuSection = menuTarget ? shown.find((s) => s.key === menuTarget.section) : undefined;
  const programmedRefsOf = (ids: readonly string[]) =>
    ids.flatMap((id) => {
      const f = fixtures.find((x) => x.id === id);
      return f ? [id, ...pixelRefsOf({ fixtureModels }, f)] : [];
    });

  const swatch = (it: SwatchItem, sectionKey: string) => {
    const rgb = colors.get(it.fixtureId) ?? [0, 0, 0];
    const [r, g, b] = rgb;
    const level = Math.max(r, g, b) / 255;
    const isSelected = selectedExact.has(it.fixtureId);
    const partSelected = !isSelected && selectedBase.has(it.fixtureId);
    const programmed = programmedBase.has(it.fixtureId);
    const pixelHeads = density === "compact" ? [] : (heads.get(it.fixtureId) ?? []);
    const mirrorText = it.mirrors.map((m) => `U${m.universe} @${m.address}`).join("、");
    const flags = [
      strobing.has(it.fixtureId) ? t("editor.swatches.strobe") : null,
      it.parked ? t("editor.swatches.parked") : null,
      locateId === it.fixtureId ? t("editor.swatches.locating") : null,
    ].filter((x): x is string => x !== null);
    const detail = [
      `${it.name} · U${it.universe} @${it.address}–${it.end}`,
      it.mirrors.length > 0 ? t("editor.swatches.mirrorTo", { targets: mirrorText }) : null,
      it.conflict ? t("editor.swatches.conflict") : null,
      programmed ? t("editor.preview.inProgrammer") : null,
      ...flags,
    ]
      .filter(Boolean)
      .join(" · ");
    const text = density === "compact" ? "" : swatchLabelText(label, it, rgb);
    return (
      <li key={`${sectionKey}:${it.fixtureId}`} className="min-w-0" title={detail}>
        <SwatchButton
          id={it.fixtureId}
          dragRefs={isSelected || partSelected ? [...selectedBase] : [it.fixtureId]}
          name={it.name}
          ariaLabel={[
            t("editor.preview.swatch", { name: it.name, r, g, b }),
            t("editor.swatches.address", { universe: it.universe, address: it.address }),
            ...(it.conflict ? [t("editor.swatches.conflict")] : []),
            ...flags,
          ].join("，")}
          pressed={isSelected}
          onClick={(e) => {
            const head = (e.target as HTMLElement).closest<HTMLElement>("[data-head]")?.dataset.head;
            if (head) pickPixel(refOf(it.fixtureId, Number(head)), e);
            else pick(it.fixtureId, e);
          }}
          onContextMenu={() => {
            if (!selectedBase.has(it.fixtureId)) setSelected([it.fixtureId]);
            setMenuTarget({ id: it.fixtureId, section: sectionKey });
          }}
          onPointerEnter={() => setHover(it.fixtureId)}
          className={cn(
            "relative block w-full cursor-pointer overflow-hidden rounded-md border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            HEIGHT[density],
            it.conflict ? "border-destructive ring-1 ring-destructive" : "border-border",
            isSelected && "border-primary ring-2 ring-primary/60",
            partSelected && "border-primary/70 ring-1 ring-primary/40",
            hover === it.fixtureId && !isSelected && "outline outline-2 outline-offset-1 outline-foreground/60",
          )}
          style={{ backgroundColor: rgbCss(rgb) }}
        >
          {/* 像素分段：每段是一个像素的颜色，点某一段选中这个像素 */}
          {pixelHeads.length > 0 && (
            <span aria-hidden className="absolute inset-x-0 bottom-1 flex h-[45%] border-t border-background/40">
              {pixelHeads.length <= MAX_PIXEL_SEGMENTS ? (
                pixelHeads.map((h) => {
                  const ref = refOf(it.fixtureId, h);
                  return (
                    <span
                      key={h}
                      data-head={h}
                      className={cn("min-w-0 flex-1 bg-(--px)", selectedExact.has(ref) && "outline outline-2 -outline-offset-2 outline-primary")}
                      style={{ "--px": rgbCss(colors.get(ref) ?? [0, 0, 0]) } as CSSProperties}
                    />
                  );
                })
              ) : (
                <span
                  className="block h-full w-full bg-(--strip)"
                  style={
                    {
                      "--strip": `linear-gradient(to right, ${pixelHeads.map((h) => rgbCss(colors.get(refOf(it.fixtureId, h)) ?? [0, 0, 0])).join(", ")})`,
                    } as CSSProperties
                  }
                />
              )}
            </span>
          )}
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
          {flags.length > 0 && (
            <span aria-hidden className="absolute bottom-1.5 left-1 flex items-center gap-0.5 rounded-sm bg-background/70 px-0.5 text-[9px] leading-none text-foreground">
              {strobing.has(it.fixtureId) && <Zap data-testid="swatch-strobe" className="size-2.5" />}
              {it.parked && <span data-testid="swatch-parked" className="font-bold">P</span>}
              {locateId === it.fixtureId && <Crosshair data-testid="swatch-locate" className="size-2.5 text-primary" />}
            </span>
          )}
        </SwatchButton>
        {text && (
          <p className="mt-1 flex min-w-0 items-baseline justify-center gap-1 text-[11px] text-muted-foreground">
            <span className={cn("truncate", (label === "level" || label === "hex") && "num")}>{text}</span>
            {label === "name" && <span className="num shrink-0 text-[10px] opacity-80">@{it.address}</span>}
          </p>
        )}
      </li>
    );
  };

  const box = marquee?.active
    ? {
        left: Math.min(marquee.x0, marquee.x1),
        top: Math.min(marquee.y0, marquee.y1),
        width: Math.abs(marquee.x1 - marquee.x0),
        height: Math.abs(marquee.y1 - marquee.y0),
      }
    : null;

  return (
    <div
      ref={rootRef}
      className="relative grid gap-2"
      onPointerLeave={() => setHover(null)}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div data-tour="preview-swatch-tools" data-swatch-tools className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
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
            icon: v === "large" ? <Square aria-hidden /> : v === "comfortable" ? <LayoutGrid aria-hidden /> : <Rows3 aria-hidden />,
            labelClassName: "sr-only",
            title: t(`editor.swatches.densities.${v}`),
          }))}
          onChange={setDensity}
        />
        <Select value={label} onValueChange={(v) => setLabel(v as SwatchLabel)}>
          <SelectTrigger className="h-6 w-auto gap-1 px-2 text-[11px]" aria-label={t("editor.swatches.label")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SWATCH_LABELS.map((l) => (
              <SelectItem key={l} value={l}>
                {t(`editor.swatches.labels.${l}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Segmented<SwatchSort>
          size="xs"
          ariaLabel={t("editor.swatches.sort")}
          value={sort}
          options={(["address", "stage"] as const).map((v) => ({ value: v, label: t(`editor.swatches.sorts.${v}`) }))}
          onChange={setSort}
        />
        <span className="flex items-center">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={t("editor.swatches.expandAll")}
            title={t("editor.swatches.expandAll")}
            disabled={collapsedKeys.length === 0}
            onClick={() => setCollapsedKeys([])}
          >
            <ChevronsUpDown aria-hidden />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={t("editor.swatches.collapseAll")}
            title={t("editor.swatches.collapseAll")}
            onClick={() => setCollapsedKeys(sections.map((s) => s.key))}
          >
            <ChevronsDownUp aria-hidden />
          </Button>
          <HelpTip topic="editor.help.swatches" />
        </span>
      </div>
      <div data-swatch-tools className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="relative min-w-40 flex-1">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            aria-label={t("editor.swatches.search")}
            placeholder={t("editor.swatches.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-7 w-full rounded-md border border-input bg-transparent pr-7 pl-7 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          {query && (
            <button
              type="button"
              aria-label={t("editor.swatches.clearSearch")}
              onClick={() => setQuery("")}
              className="absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X aria-hidden className="size-3.5" />
            </button>
          )}
        </div>
        <Segmented<SwatchFilter>
          size="xs"
          ariaLabel={t("editor.swatches.filter")}
          value={filter}
          options={SWATCH_FILTERS.map((v) => ({ value: v, label: t(`editor.swatches.filters.${v}`) }))}
          onChange={setFilter}
        />
      </div>
      <p aria-label={t("editor.swatches.legend")} className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-muted-foreground">
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
        <span className="flex items-center gap-1">
          <Zap aria-hidden className="size-3" />
          {t("editor.swatches.strobe")}
        </span>
        <span className="flex items-center gap-1">
          <span aria-hidden className="text-[10px] font-bold text-foreground">
            P
          </span>
          {t("editor.swatches.parked")}
        </span>
      </p>

      {shown.length === 0 && (
        <div className="flex flex-col items-center gap-2 p-4 text-center text-xs text-muted-foreground">
          <p>{t("editor.swatches.noMatch")}</p>
          <button
            type="button"
            className="rounded-sm underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              setQuery("");
              setFilter("all");
            }}
          >
            {t("editor.swatches.clearFilter")}
          </button>
        </div>
      )}

      <ContextMenu onOpenChange={(open) => !open && setMenuTarget(null)}>
        <ContextMenuTrigger asChild>
          <div className="grid gap-2">
            {shown.map((s) => {
              const open = !collapsed.has(s.key);
              const title = titleOf(s);
              return (
                <section key={s.key} aria-label={title} className="grid gap-1.5">
                  <header className="sticky top-0 z-10 flex items-center gap-1.5 rounded-md border border-border bg-surface-2/95 px-1.5 py-1 backdrop-blur-sm">
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
                        title={t("editor.swatches.selectSectionHint", { name: title })}
                        onClick={(e) => {
                          const ids = s.items.map((it) => it.fixtureId);
                          // Ctrl / ⌘：并入原选择
                          setSelected(e.ctrlKey || e.metaKey ? [...new Set([...selectedIds, ...ids])] : ids);
                        }}
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
        </ContextMenuTrigger>
        {menuTarget && (
          <ContextMenuContent aria-label={t("editor.swatches.menu")}>
            <ContextMenuItem onSelect={() => setSelected([menuTarget.id])}>{t("editor.swatches.menuSelectOnly")}</ContextMenuItem>
            {menuSection && (
              <ContextMenuItem onSelect={() => setSelected(menuSection.items.map((it) => it.fixtureId))}>
                {t("editor.swatches.menuSelectSection", { name: titleOf(menuSection) })}
              </ContextMenuItem>
            )}
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => revealInPatch(menuIds)}>{t("editor.swatches.menuReveal")}</ContextMenuItem>
            <ContextMenuItem onSelect={() => void toggleLocate(menuTarget.id)}>
              {t(locateId === menuTarget.id ? "editor.swatches.menuLocateStop" : "editor.swatches.menuLocate")}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              disabled={!menuIds.some((id) => programmedBase.has(id))}
              onSelect={() => {
                setValues(knockout(values, programmedRefsOf(menuIds)));
                announce(t("editor.programmer.knocked", { count: menuIds.length }));
              }}
            >
              {t("editor.swatches.menuKnockout", { count: menuIds.length })}
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => {
                let created: string[] = [];
                update((d) => {
                  created = ensureRefTracks(d, menuIds);
                });
                announce(t("editor.swatches.tracksCreated", { count: created.length }));
              }}
            >
              {t("editor.swatches.menuTracks", { count: menuIds.length })}
            </ContextMenuItem>
          </ContextMenuContent>
        )}
      </ContextMenu>

      {box && (
        <div
          aria-hidden
          data-testid="swatch-marquee"
          className="pointer-events-none absolute rounded-sm border border-primary bg-primary/10"
          style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
        />
      )}
    </div>
  );
}

interface SwatchButtonProps {
  id: string;
  /** 拖到时间线时带上的引用 */
  dragRefs: string[];
  name: string;
  ariaLabel: string;
  pressed: boolean;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  onContextMenu: () => void;
  onPointerEnter: () => void;
  className: string;
  style: CSSProperties;
  children: ReactNode;
}

/**
 * 一个色块按钮：可点选、可拖到时间线（为所选灯建轨道）。
 */
function SwatchButton({ id, dragRefs, name, ariaLabel, pressed, onClick, onContextMenu, onPointerEnter, className, style, children }: SwatchButtonProps) {
  const data: FixtureInstanceDragData = { kind: "fixtureInstance", refs: dragRefs, name: dragRefs.length > 1 ? `${name} +${dragRefs.length - 1}` : name };
  const { setNodeRef, listeners, isDragging } = useDraggable({ id: `swatch:${id}`, data });
  return (
    <button
      ref={setNodeRef}
      type="button"
      aria-pressed={pressed}
      aria-label={ariaLabel}
      data-fixture-id={id}
      {...listeners}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onPointerEnter={onPointerEnter}
      className={cn(className, isDragging && "opacity-60")}
      style={style}
    >
      {children}
    </button>
  );
}

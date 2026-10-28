import { forwardRef, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { useDroppable } from "@dnd-kit/core";
import { ChevronDown, ChevronRight, Rows3, SquareStack, TableProperties, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Segmented } from "@/shared/components/Segmented";
import { UNIVERSE_DROP_PREFIX, type UniverseDropData } from "../hooks/fixtureDrop";
import { DMX_CHANNELS } from "../lib/project";
import { channelStrip, universeCards, type UniverseCard, type UniverseSegment } from "../lib/universeView";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";

/** 通道格每行的格数（512 = 64 × 8，属性面板里不占太多高度）。 */
const STRIP_COLUMNS = 64;

/** 数据色：按型号取色相，冲突用警示色（经 CSS 变量传入）。 */
const segStyle = (hue: number | null): CSSProperties => ({ "--seg-h": String(hue ?? 0) }) as CSSProperties;
const SEG_FILL = "bg-[hsl(var(--seg-h)_62%_52%)]";
const SEG_FILL_SOFT = "bg-[hsl(var(--seg-h)_45%_45%/0.45)]";

interface UniverseOverviewProps {
  /** 被选中的灯具（高亮） */
  selectedIds: readonly string[];
  /** 打开某个 Universe 的 DMX 通道视图 */
  onPickUniverse?: (universe: number) => void;
}

/**
 * 多 Universe 的紧凑视图（属性面板宽度有限）：
 *
 * - 每个 Universe 一行摘要：展开箭头、识别色、U 编号与名称、内嵌的迷你占用条、`n/512`、冲突数；
 *   展开后才显示地址刻度、输出端口与按地址排列的灯具清单。
 * - **通道格**：512 格（64 × 8）逐通道显示归属，起始地址画左侧细线，冲突格用警示色。
 * - 每张卡片是灯具的拖拽放置区：从素材库把灯具拖到卡片上，从落点对应的地址开始配接。
 *
 * 悬停色块 / 格子时与舞台监视器互相高亮（`hoverFixtureId`）；色块是视觉辅助，
 * 读屏用户读到的是每张卡片里的灯具清单（收起或通道格模式下清单仅供读屏）。
 */
export function UniverseOverview({ selectedIds, onPickUniverse }: UniverseOverviewProps) {
  const { t } = useTranslation();
  const fixtures = useProjectStore((s) => s.project.fixtures);
  const fixtureModels = useProjectStore((s) => s.project.fixtureModels);
  const universes = useProjectStore((s) => s.project.output.universes);
  const view = useEditorUiStore((s) => s.universeView);
  const setView = useEditorUiStore((s) => s.setUniverseView);
  const hover = useEditorUiStore((s) => s.hoverFixtureId);
  const setHover = useEditorUiStore((s) => s.setHoverFixture);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const cards = useMemo(() => universeCards({ fixtures, fixtureModels, output: { universes } }), [fixtures, fixtureModels, universes]);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);

  if (cards.length === 0) return null;

  const toggle = (u: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(u)) next.delete(u);
      else next.add(u);
      return next;
    });
  const marked = (id: string) => id === hover || selected.has(id);

  /** 事件委托：指针所在色块 / 格子的灯具。 */
  const onHoverMove = (e: PointerEvent<HTMLElement>) => {
    const owner = (e.target as HTMLElement).closest<HTMLElement>("[data-owner]")?.dataset.owner;
    setHover(owner || null);
  };

  return (
    <div className="grid gap-1.5">
      <div data-tour="universe-view" className="flex items-center justify-between gap-2">
        <Segmented<"cards" | "strip">
          size="xs"
          ariaLabel={t("editor.universe.view")}
          value={view}
          options={[
            { value: "cards", label: t("editor.universe.cards"), icon: <SquareStack aria-hidden /> },
            { value: "strip", label: t("editor.universe.strip"), icon: <TableProperties aria-hidden /> },
          ]}
          onChange={setView}
        />
        <span className="text-[11px] text-muted-foreground">{t("editor.universe.count", { count: cards.length })}</span>
      </div>
      <ul className="grid gap-1" onPointerMove={onHoverMove} onPointerLeave={() => setHover(null)}>
        {cards.map((card) => (
          <li key={card.universe}>
            <UniverseCardView
              card={card}
              open={expanded.has(card.universe)}
              strip={view === "strip"}
              marked={marked}
              onToggle={() => toggle(card.universe)}
              onPickUniverse={onPickUniverse}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 一个 Universe 的卡片（也是灯具的拖拽放置区）。 */
function UniverseCardView({
  card,
  open,
  strip,
  marked,
  onToggle,
  onPickUniverse,
}: {
  card: UniverseCard;
  open: boolean;
  strip: boolean;
  marked: (id: string) => boolean;
  onToggle: () => void;
  onPickUniverse?: (universe: number) => void;
}) {
  const { t } = useTranslation();
  const barRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  // 落点地址：占用条按横向比例；通道格按行列（64 × 8）
  const addressAt = (x: number, y: number): number | null => {
    const clamp01 = (v: number) => Math.min(0.9999, Math.max(0, v));
    const grid = gridRef.current?.getBoundingClientRect();
    if (grid && grid.width > 0 && grid.height > 0) {
      const col = Math.floor(clamp01((x - grid.left) / grid.width) * STRIP_COLUMNS);
      const row = Math.floor(clamp01((y - grid.top) / grid.height) * (DMX_CHANNELS / STRIP_COLUMNS));
      return row * STRIP_COLUMNS + col + 1;
    }
    const bar = barRef.current?.getBoundingClientRect();
    if (bar && bar.width > 0) return 1 + Math.floor(clamp01((x - bar.left) / bar.width) * DMX_CHANNELS);
    return null;
  };
  const data: UniverseDropData = { kind: "universe", universe: card.universe, addressAt };
  const { setNodeRef, isOver, active } = useDroppable({ id: `${UNIVERSE_DROP_PREFIX}${card.universe}`, data });
  const dropping = isOver && (active?.data.current as { kind?: string } | undefined)?.kind === "fixtureModel";
  const title = card.label ? `U${card.universe} · ${card.label}` : `U${card.universe}`;
  const full = card.used / DMX_CHANNELS;
  const summary = t("editor.patch.universeSummary", { universe: card.universe, used: card.used, total: DMX_CHANNELS, conflicts: card.conflicts });

  return (
    <section
      ref={setNodeRef}
      aria-label={title}
      data-universe={card.universe}
      className={cn(
        "grid gap-1 rounded-md border bg-card px-1.5 py-1 transition-colors",
        dropping ? "border-primary bg-primary/10" : "border-border",
      )}
    >
      <header className="flex items-center gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-5 shrink-0 [&_svg]:size-3.5"
          aria-expanded={open}
          aria-label={t(open ? "editor.universe.collapse" : "editor.universe.expand", { name: title })}
          onClick={onToggle}
        >
          {open ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
        </Button>
        {card.color && (
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-full bg-(--u-color)"
            style={{ "--u-color": `rgb(${card.color[0]} ${card.color[1]} ${card.color[2]})` } as CSSProperties}
          />
        )}
        <h4 className="w-16 shrink-0 truncate text-xs font-medium" title={title}>
          {title}
        </h4>
        {!strip && <MiniBar ref={barRef} card={card} marked={marked} label={summary} />}
        {strip && <span className="min-w-0 flex-1" />}
        {card.conflicts > 0 && (
          <span className="flex shrink-0 items-center gap-0.5 text-[11px] font-medium text-destructive" title={t("editor.universe.conflicts", { count: card.conflicts })}>
            <TriangleAlert className="size-3" aria-hidden />
            <span className="num">{card.conflicts}</span>
            <span className="sr-only">{t("editor.universe.conflicts", { count: card.conflicts })}</span>
          </span>
        )}
        <span className={cn("num shrink-0 text-[11px]", full >= 0.9 ? "text-warning" : "text-muted-foreground")}>
          {card.used}/{DMX_CHANNELS}
        </span>
        {onPickUniverse && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-5 shrink-0 [&_svg]:size-3.5"
            aria-label={t("editor.patch.showChannels", { universe: card.universe })}
            title={t("editor.patch.showChannels", { universe: card.universe })}
            onClick={() => onPickUniverse(card.universe)}
          >
            <Rows3 aria-hidden />
          </Button>
        )}
      </header>
      {dropping && <p className="px-6 text-[11px] text-primary">{t("editor.universe.dropHint")}</p>}
      {strip && <ChannelGrid ref={gridRef} card={card} marked={marked} label={summary} />}
      {open && (
        <div className="grid gap-1 pl-6">
          {!strip && <AddressTicks card={card} />}
          <p className="text-[11px] text-muted-foreground">
            {t("editor.universe.fixtures", { count: card.fixtures })} ·{" "}
            {card.ports.length > 0
              ? card.ports
                  .map((p) => t("editor.universe.port", { protocol: p.protocol === "sacn" ? "sACN" : "Art-Net", target: p.target, remote: p.remote }))
                  .join("，")
              : t("editor.universe.noPorts")}
          </p>
        </div>
      )}
      <SegmentList card={card} marked={marked} visible={open && !strip} />
    </section>
  );
}

/** 卡片头部内嵌的迷你占用条。 */
const MiniBar = forwardRef<HTMLDivElement, { card: UniverseCard; marked: (id: string) => boolean; label: string }>(function MiniBar(
  { card, marked, label },
  ref,
) {
  return (
    <div ref={ref} role="img" aria-label={label} data-bar className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
      {card.segments.map((s, i) => (
        <SegmentBlock key={`${s.fixtureId}-${i}`} seg={s} marked={marked(s.fixtureId)} />
      ))}
    </div>
  );
});

/** 展开后的起始地址刻度（色块够宽时才标）。 */
function AddressTicks({ card }: { card: UniverseCard }) {
  return (
    <div aria-hidden className="relative h-3 text-[9px] leading-3 text-muted-foreground">
      {card.segments
        .filter((s, i, all) => !s.mirror && (i === 0 || s.start - all[i - 1].start >= 32))
        .map((s) => (
          <span key={`a-${s.fixtureId}`} className="num absolute -translate-x-px" style={{ left: `${((s.start - 1) / DMX_CHANNELS) * 100}%` }}>
            {s.start}
          </span>
        ))}
    </div>
  );
}

/** 512 格通道格（64 × 8）。 */
const ChannelGrid = forwardRef<HTMLDivElement, { card: UniverseCard; marked: (id: string) => boolean; label: string }>(function ChannelGrid(
  { card, marked, label },
  ref,
) {
  const { t } = useTranslation();
  const cells = channelStrip(card);
  const names = new Map(card.segments.map((s) => [s.fixtureId, s.name]));
  return (
    <div
      ref={ref}
      role="img"
      aria-label={label}
      className="grid gap-px rounded-sm bg-border p-px"
      style={{ gridTemplateColumns: `repeat(${STRIP_COLUMNS}, minmax(0, 1fr))` }}
    >
      {cells.map((c) => {
        const conflict = c.owners.length > 1;
        const owner = c.owners[0];
        return (
          <span
            key={c.channel}
            data-owner={owner}
            title={
              owner
                ? t("editor.universe.cell", { channel: c.channel, name: c.owners.map((o) => names.get(o) ?? o).join(" / ") })
                : t("editor.universe.cellEmpty", { channel: c.channel })
            }
            className={cn(
              "h-1.5",
              !owner ? "bg-muted" : conflict ? "bg-destructive" : c.mirror ? SEG_FILL_SOFT : SEG_FILL,
              c.head && "shadow-[inset_1px_0_0_var(--foreground)]",
              owner && marked(owner) && "outline outline-1 outline-foreground",
            )}
            style={owner ? segStyle(c.hue) : undefined}
          />
        );
      })}
    </div>
  );
});

/** 按地址排列的灯具清单（收起时只给读屏）。 */
function SegmentList({ card, marked, visible }: { card: UniverseCard; marked: (id: string) => boolean; visible: boolean }) {
  const { t } = useTranslation();
  return (
    <ul className={cn(visible ? "grid gap-0.5 pl-6" : "sr-only")} aria-label={t("editor.universe.fixtureList", { universe: card.universe })}>
      {card.segments.map((s, i) => (
        <li
          key={`${s.fixtureId}-${i}`}
          data-owner={s.fixtureId}
          className={cn("flex items-center gap-1.5 rounded-sm px-1 text-[11px] leading-5", marked(s.fixtureId) && "bg-accent text-accent-foreground")}
        >
          <span aria-hidden className={cn("size-2 shrink-0 rounded-[2px]", s.conflict ? "bg-destructive" : SEG_FILL)} style={segStyle(s.hue)} />
          <span className="num w-14 shrink-0 text-muted-foreground">
            {s.start}–{s.end}
          </span>
          <span className="min-w-0 flex-1 truncate">{s.name}</span>
          {s.mirror && <span className="shrink-0 text-muted-foreground">{t("editor.universe.mirror")}</span>}
          {s.conflict && <span className="shrink-0 font-medium text-destructive">{t("editor.universe.conflict")}</span>}
        </li>
      ))}
    </ul>
  );
}

/** 占用条里的一个灯具色块。 */
function SegmentBlock({ seg, marked }: { seg: UniverseSegment; marked: boolean }) {
  return (
    <span
      data-owner={seg.fixtureId}
      title={`${seg.name} · ${seg.start}–${seg.end}`}
      className={cn(
        "absolute inset-y-0 border-r border-background/70",
        seg.conflict ? "bg-destructive/85" : seg.mirror ? SEG_FILL_SOFT : SEG_FILL,
        marked && "z-[1] ring-1 ring-inset ring-foreground",
      )}
      style={{
        ...segStyle(seg.hue),
        left: `${((seg.start - 1) / DMX_CHANNELS) * 100}%`,
        width: `${((seg.end - seg.start + 1) / DMX_CHANNELS) * 100}%`,
      }}
    />
  );
}

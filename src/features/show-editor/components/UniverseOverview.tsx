import { useMemo, useState, type CSSProperties, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Rows3, SquareStack, TableProperties, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Segmented } from "@/shared/components/Segmented";
import { DMX_CHANNELS } from "../lib/project";
import { channelStrip, universeCards, type UniverseCard, type UniverseSegment } from "../lib/universeView";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";

/** 通道条每行的格数（512 = 32 × 16）。 */
const STRIP_COLUMNS = 32;

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
 * 多 Universe 的直观视图（替代单条的占用图）：
 *
 * - **卡片**：每个 Universe 一张，标出名称与颜色、占用（n/512）、灯具数、输出端口与冲突；
 *   灯具按地址排成色块（同型号同色），色块下标出起始地址，可折叠出按地址排列的灯具清单；
 * - **通道格**：512 格（32 × 16）逐通道显示归属，起始地址加粗左边，冲突格用警示色。
 *
 * 悬停色块 / 格子时与舞台监视器互相高亮（`hoverFixtureId`）；色块是视觉辅助，
 * 读屏用户读到的是每张卡片里的灯具清单（通道格模式下清单仅供读屏）。
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
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(new Set());
  const cards = useMemo(() => universeCards({ fixtures, fixtureModels, output: { universes } }), [fixtures, fixtureModels, universes]);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);

  if (cards.length === 0) return null;

  const toggle = (u: number) =>
    setCollapsed((prev) => {
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

  const summary = (card: UniverseCard) =>
    t("editor.patch.universeSummary", { universe: card.universe, used: card.used, total: DMX_CHANNELS, conflicts: card.conflicts });

  /** 读屏用的灯具清单（按地址）。 */
  const segmentList = (card: UniverseCard, visible: boolean) => (
    <ul className={cn(visible ? "grid gap-0.5" : "sr-only")} aria-label={t("editor.universe.fixtureList", { universe: card.universe })}>
      {card.segments.map((s, i) => (
        <li
          key={`${s.fixtureId}-${i}`}
          data-owner={s.fixtureId}
          className={cn(
            "flex items-center gap-1.5 rounded-sm px-1 text-[11px] leading-5",
            marked(s.fixtureId) && "bg-accent text-accent-foreground",
          )}
        >
          <span aria-hidden className={cn("size-2.5 shrink-0 rounded-[2px]", s.conflict ? "bg-destructive" : SEG_FILL)} style={segStyle(s.hue)} />
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

  const bar = (card: UniverseCard) => (
    <div className="grid gap-0.5">
      <div role="img" aria-label={summary(card)} className="relative h-4 overflow-hidden rounded-sm bg-muted">
        {card.segments.map((s, i) => (
          <SegmentBlock key={`${s.fixtureId}-${i}`} seg={s} marked={marked(s.fixtureId)} label={s.mirror ? t("editor.patch.mirrorOf", { name: s.name }) : s.name} />
        ))}
      </div>
      {/* 起始地址刻度：色块够宽时才标，避免挤在一起 */}
      <div aria-hidden className="relative h-3 text-[9px] leading-3 text-muted-foreground">
        {card.segments
          .filter((s, i, all) => !s.mirror && (i === 0 || s.start - all[i - 1].start >= 24))
          .map((s) => (
            <span key={`a-${s.fixtureId}`} className="num absolute -translate-x-px" style={{ left: `${((s.start - 1) / DMX_CHANNELS) * 100}%` }}>
              {s.start}
            </span>
          ))}
      </div>
    </div>
  );

  const strip = (card: UniverseCard) => {
    const cells = channelStrip(card);
    const names = new Map(card.segments.map((s) => [s.fixtureId, s.name]));
    return (
      <div
        role="img"
        aria-label={summary(card)}
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
                "h-2.5",
                !owner ? "bg-muted" : conflict ? "bg-destructive" : c.mirror ? SEG_FILL_SOFT : SEG_FILL,
                c.head && "shadow-[inset_2px_0_0_var(--foreground)]",
                owner && marked(owner) && "outline outline-1 outline-foreground",
              )}
              style={owner ? segStyle(c.hue) : undefined}
            />
          );
        })}
      </div>
    );
  };

  return (
    <div className="grid gap-2">
      <div data-tour="universe-view" className="flex items-center justify-between gap-2">
        <Segmented<"cards" | "strip">
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
      <ul className="grid gap-2" onPointerMove={onHoverMove} onPointerLeave={() => setHover(null)}>
        {cards.map((card) => {
          const open = !collapsed.has(card.universe);
          const full = card.used / DMX_CHANNELS;
          const title = card.label ? `U${card.universe} · ${card.label}` : `U${card.universe}`;
          return (
            <li key={card.universe}>
              <section aria-label={title} className="grid gap-1.5 rounded-md border border-border bg-card p-2">
                <header className="flex items-center gap-1.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-5 [&_svg]:size-3.5"
                    aria-expanded={open}
                    aria-label={t(open ? "editor.universe.collapse" : "editor.universe.expand", { name: title })}
                    onClick={() => toggle(card.universe)}
                  >
                    {open ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
                  </Button>
                  {card.color && (
                    <span
                      aria-hidden
                      className="size-2.5 shrink-0 rounded-full bg-(--u-color)"
                      style={{ "--u-color": `rgb(${card.color[0]} ${card.color[1]} ${card.color[2]})` } as CSSProperties}
                    />
                  )}
                  <h4 className="min-w-0 flex-1 truncate text-xs font-medium">{title}</h4>
                  {card.conflicts > 0 && (
                    <span className="flex items-center gap-0.5 text-[11px] font-medium text-destructive">
                      <TriangleAlert className="size-3" aria-hidden />
                      {t("editor.universe.conflicts", { count: card.conflicts })}
                    </span>
                  )}
                  <span className={cn("num text-[11px]", full >= 0.9 ? "text-warning" : "text-muted-foreground")}>
                    {card.used}/{DMX_CHANNELS}
                  </span>
                  {onPickUniverse && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-5 [&_svg]:size-3.5"
                      aria-label={t("editor.patch.showChannels", { universe: card.universe })}
                      title={t("editor.patch.showChannels", { universe: card.universe })}
                      onClick={() => onPickUniverse(card.universe)}
                    >
                      <Rows3 aria-hidden />
                    </Button>
                  )}
                </header>
                <p className="text-[11px] text-muted-foreground">
                  {t("editor.universe.fixtures", { count: card.fixtures })} ·{" "}
                  {card.ports.length > 0
                    ? card.ports
                        .map((p) => t("editor.universe.port", { protocol: p.protocol === "sacn" ? "sACN" : "Art-Net", target: p.target, remote: p.remote }))
                        .join("，")
                    : t("editor.universe.noPorts")}
                </p>
                {view === "cards" ? bar(card) : strip(card)}
                {open && segmentList(card, view === "cards")}
              </section>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** 卡片里的一个灯具色块。 */
function SegmentBlock({ seg, marked, label }: { seg: UniverseSegment; marked: boolean; label: string }) {
  return (
    <span
      data-owner={seg.fixtureId}
      title={`${label} · ${seg.start}–${seg.end}`}
      className={cn(
        "absolute inset-y-0 border-r border-background/70",
        seg.conflict ? "bg-destructive/85" : seg.mirror ? SEG_FILL_SOFT : SEG_FILL,
        seg.mirror && "bg-[repeating-linear-gradient(-45deg,transparent_0_2px,var(--background)_2px_3px)]",
        marked && "z-[1] ring-2 ring-inset ring-foreground",
      )}
      style={{
        ...segStyle(seg.hue),
        left: `${((seg.start - 1) / DMX_CHANNELS) * 100}%`,
        width: `${((seg.end - seg.start + 1) / DMX_CHANNELS) * 100}%`,
      }}
    />
  );
}

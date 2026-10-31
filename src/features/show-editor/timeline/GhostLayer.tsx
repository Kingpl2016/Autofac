import { memo, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, RotateCcw, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { announce } from "@/shared/stores/announcerStore";
import { MAX_GHOSTS_PER_TRACK, stagedGhosts, type Ghost } from "../ai/ghosts";
import { rejectOp, restoreOps, useAiStagingStore, dependentsOf } from "../stores/useAiStagingStore";
import type { RowLayout } from "./timelineLayout";

/** 改动的说明（操作名 + 关键参数）。 */
function opText(t: (k: string, o?: Record<string, unknown>) => string, op: Record<string, unknown> | undefined): string {
  if (!op) return "";
  const name = t(`editor.ai.ops.${String(op.op)}`, { defaultValue: String(op.op) });
  const what = op.effect ?? op.recipe ?? op.template ?? op.events ?? "";
  return what ? `${name} · ${String(what)}` : name;
}

interface GhostLayerProps {
  /** 轨道 id → 行号（含待审阅改动新建的轨道） */
  trackIndex: ReadonlyMap<string, number>;
  layout: RowLayout;
  rowFrom: number;
  rowTo: number;
  timeFrom: number;
  timeTo: number;
  xOf: (ms: number) => number;
}

/** 一个虚影：虚线 / 斜纹 / 半透明描边，悬停时显示是哪条操作，并可拒绝它。 */
function GhostClip({ ghost, left, top, width, height, focused, onFocus, first }: { ghost: Ghost; left: number; top: number; width: number; height: number; focused: boolean; onFocus: (on: boolean) => void; first: boolean }) {
  const { t } = useTranslation();
  const staged = useAiStagingStore((s) => s.staged);
  const op = staged?.allOps[ghost.opIndex] as Record<string, unknown> | undefined;
  const reject = () => {
    if (!staged) return;
    const deps = dependentsOf(staged, ghost.opIndex);
    const r = rejectOp(ghost.opIndex);
    if (!r.ok) announce(t("editor.ai.ghost.cannotReject"));
    else announce(t(deps.length > 0 ? "editor.ai.ghost.rejectedWithDeps" : "editor.ai.ghost.rejected", { count: r.rejected.length }));
  };
  const label = t(`editor.ai.ghost.kinds.${ghost.kind}`, { op: opText(t, op) });
  return (
    <div
      data-ghost={ghost.kind}
      data-op-index={ghost.opIndex}
      data-tour={first ? "ai-ghost" : undefined}
      className={cn(
        "group/ghost absolute z-[15] rounded-sm",
        ghost.kind === "add" && "border-2 border-dashed border-primary bg-primary/15",
        ghost.kind === "change" && "hatch-removed border-2 border-primary/80 bg-primary/10",
        ghost.kind === "remove" && "border-2 border-destructive/80 bg-destructive/15 [background-image:linear-gradient(to_bottom_right,transparent_calc(50%-1px),var(--color-destructive)_50%,transparent_calc(50%+1px))]",
        focused && "ring-2 ring-ring",
      )}
      style={{ left, top: top + 2, width: Math.max(4, width), height: Math.max(8, height - 4) }}
      onPointerEnter={() => onFocus(true)}
      onPointerLeave={() => onFocus(false)}
      // 虚影不参与时间线的拖动 / 框选
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span className="sr-only">{label}</span>
      {focused && (
        <div className="absolute -top-6 left-0 z-40 flex items-center gap-1 whitespace-nowrap rounded-md border border-border bg-popover px-1.5 py-0.5 text-[11px] text-popover-foreground shadow-md">
          <span className="max-w-56 truncate">{label}</span>
          <button
            type="button"
            className="inline-flex items-center gap-0.5 rounded px-1 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t("editor.ai.ghost.keep", { op: opText(t, op) })}
            title={t("editor.ai.ghost.keepHint")}
            onClick={() => onFocus(false)}
          >
            <Check className="size-3" aria-hidden />
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-0.5 rounded px-1 text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t("editor.ai.ghost.reject", { op: opText(t, op) })}
            onClick={reject}
          >
            <X className="size-3" aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 时间线上的改动虚影层：待审阅的 AI 改动（预览开着时）在对应轨道上画成虚影。
 * 只画可见范围；一条轨道上超过 200 个时合并成一条“改动带”，标出数量。
 */
export const GhostLayer = memo(function GhostLayer({ trackIndex, layout, rowFrom, rowTo, timeFrom, timeTo, xOf }: GhostLayerProps) {
  const { t } = useTranslation();
  const staged = useAiStagingStore((s) => (s.previewing ? s.staged : null));
  const [focus, setFocus] = useState<string | null>(null);
  const ghosts = useMemo(() => (staged ? stagedGhosts(staged) : []), [staged]);
  const byRow = useMemo(() => {
    const map = new Map<number, Ghost[]>();
    for (const g of ghosts) {
      const row = trackIndex.get(g.cue.trackId);
      if (row === undefined) continue;
      map.set(row, [...(map.get(row) ?? []), g]);
    }
    return map;
  }, [ghosts, trackIndex]);
  if (!staged) return null;
  const items: React.ReactNode[] = [];
  for (const [row, list] of byRow) {
    if (row < rowFrom || row >= rowTo) continue;
    const top = layout.tops[row];
    const height = layout.heights[row];
    const visible = list.filter((g) => g.cue.endMs > timeFrom && g.cue.startMs < timeTo);
    if (list.length > MAX_GHOSTS_PER_TRACK) {
      if (visible.length === 0) continue;
      const from = Math.min(...visible.map((g) => g.cue.startMs));
      const to = Math.max(...visible.map((g) => g.cue.endMs));
      items.push(
        <div
          key={`band-${row}`}
          data-ghost="band"
          className="pointer-events-none absolute z-[15] flex items-center rounded-sm border-2 border-dashed border-primary bg-primary/10 px-1 text-[10px] text-primary"
          style={{ left: xOf(from), width: Math.max(4, xOf(to) - xOf(from)), top: top + 2, height: height - 4 }}
        >
          {t("editor.ai.ghost.band", { count: list.length })}
        </div>,
      );
      continue;
    }
    for (const g of visible) {
      const key = `${g.kind}-${g.cue.id}`;
      items.push(
        <GhostClip
          key={key}
          ghost={g}
          left={xOf(g.cue.startMs)}
          width={xOf(g.cue.endMs) - xOf(g.cue.startMs)}
          top={top}
          height={height}
          focused={focus === key}
          onFocus={(on) => setFocus(on ? key : null)}
          first={items.length === 0}
        />,
      );
    }
  }
  return <>{items}</>;
});

/** 审阅卡片里被拒绝的操作：逐条恢复，或全部恢复。 */
export function RejectedOps() {
  const { t } = useTranslation();
  const staged = useAiStagingStore((s) => s.staged);
  if (!staged || staged.rejected.length === 0) return null;
  return (
    <div className="grid gap-1 rounded-md border border-border bg-muted/30 p-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{t("editor.ai.ghost.rejectedTitle", { count: staged.rejected.length })}</span>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded px-1 text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => restoreOps()}
        >
          <RotateCcw className="size-3" aria-hidden />
          {t("editor.ai.ghost.restoreAll")}
        </button>
      </div>
      <ul className="grid gap-0.5">
        {staged.rejected.map((r) => (
          <li key={r.index} className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate">
              {opText(t, staged.allOps[r.index] as unknown as Record<string, unknown>)}
              <span className="text-muted-foreground"> · {t(`editor.ai.ghost.reasons.${r.reason}`)}</span>
            </span>
            <button
              type="button"
              className="rounded px-1 text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t("editor.ai.ghost.restore", { op: opText(t, staged.allOps[r.index] as unknown as Record<string, unknown>) })}
              onClick={() => restoreOps([r.index])}
            >
              {t("editor.ai.ghost.restoreOne")}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { analyzePatch, spansByUniverse, universeUsage, usedUniverses } from "../lib/patch";
import { DMX_CHANNELS, type ShowProject } from "../lib/project";

interface UniverseMapProps {
  project: Pick<ShowProject, "fixtures" | "fixtureModels"> & { output?: Pick<ShowProject["output"], "universes"> };
  /** 被选中的灯具（在条上高亮） */
  selectedIds: readonly string[];
  /** 点击某个 Universe 的条（例如切换 DMX 通道视图） */
  onPickUniverse?: (universe: number) => void;
}

/**
 * Universe 占用图（容量条）：每个用到的 Universe 一条 512 通道的横条，灯具画成区间，
 * 多重配接的镜像画成斜纹，冲突的灯具用警示色；右侧显示已用通道数，接近满载时转为告警色。
 * 条本身只是视觉辅助（一个带摘要文字的图片），详细信息在灯具列表里。
 */
export function UniverseMap({ project, selectedIds, onPickUniverse }: UniverseMapProps) {
  const { t } = useTranslation();
  const rows = useMemo(() => {
    const status = analyzePatch(project);
    const spans = spansByUniverse(project);
    const usage = universeUsage(project);
    const names = new Map(project.fixtures.map((f) => [f.id, f.name]));
    const labels = new Map((project.output?.universes ?? []).map((u) => [u.universe, u.label]));
    return usedUniverses(project.fixtures).map((universe) => {
      const items = (spans.get(universe) ?? []).map((s) => ({
        ...s,
        name: names.get(s.fixtureId) ?? s.fixtureId,
        status: status.get(s.fixtureId),
      }));
      const conflicts = new Set(
        items.filter((it) => (it.status?.conflictsWith.length ?? 0) > 0).map((it) => it.fixtureId),
      ).size;
      return { universe, label: labels.get(universe) ?? "", items, usedChannels: usage.get(universe) ?? 0, conflicts };
    });
  }, [project]);

  if (rows.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((row) => {
        const full = row.usedChannels / DMX_CHANNELS;
        const bar = (
          <div
            role="img"
            aria-label={t("editor.patch.universeSummary", {
              universe: row.universe,
              used: row.usedChannels,
              total: DMX_CHANNELS,
              conflicts: row.conflicts,
            })}
            className="relative h-3 min-w-0 flex-1 overflow-hidden rounded-sm bg-muted"
          >
            {row.items.map((it, i) => {
              if (!it.status?.range) return null;
              const conflict = (it.status.conflictsWith.length ?? 0) > 0 || it.status.overflow;
              return (
                <span
                  key={`${it.fixtureId}-${i}`}
                  title={it.mirror ? t("editor.patch.mirrorOf", { name: it.name }) : it.name}
                  className={cn(
                    "absolute inset-y-0 border-r border-background/60",
                    conflict ? "bg-destructive/80" : it.mirror ? "bg-primary/35" : "bg-primary/60",
                    it.mirror && "bg-[repeating-linear-gradient(-45deg,transparent_0_2px,var(--background)_2px_3px)]",
                    selectedIds.includes(it.fixtureId) && "ring-1 ring-inset ring-foreground",
                  )}
                  style={{
                    left: `${((it.range.start - 1) / DMX_CHANNELS) * 100}%`,
                    width: `${((Math.min(it.range.end, DMX_CHANNELS) - it.range.start + 1) / DMX_CHANNELS) * 100}%`,
                  }}
                />
              );
            })}
          </div>
        );
        return (
          <li key={row.universe} className="flex items-center gap-2">
            <span className="num w-10 shrink-0 text-xs text-muted-foreground" title={row.label || undefined}>
              U{row.universe}
            </span>
            {onPickUniverse ? (
              <button
                type="button"
                className="flex min-w-0 flex-1 cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={t("editor.patch.showChannels", { universe: row.universe })}
                onClick={() => onPickUniverse(row.universe)}
              >
                {bar}
              </button>
            ) : (
              bar
            )}
            <span
              className={cn(
                "num w-14 shrink-0 text-right text-xs",
                full >= 0.9 ? "text-warning" : "text-muted-foreground",
              )}
            >
              {row.usedChannels}/{DMX_CHANNELS}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

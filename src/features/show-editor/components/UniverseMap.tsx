import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { analyzePatch, usedUniverses } from "../lib/patch";
import { DMX_CHANNELS, type ShowProject } from "../lib/project";

interface UniverseMapProps {
  project: Pick<ShowProject, "fixtures" | "fixtureModels">;
  /** 被选中的灯具（在条上高亮） */
  selectedIds: readonly string[];
}

/**
 * Universe 占用图：每个用到的 Universe 一条 512 通道的横条，灯具画成区间，冲突的灯具用警示色。
 * 条本身只是视觉辅助（一个带摘要文字的图片），详细信息在灯具列表里。
 */
export function UniverseMap({ project, selectedIds }: UniverseMapProps) {
  const { t } = useTranslation();
  const rows = useMemo(() => {
    const status = analyzePatch(project);
    return usedUniverses(project.fixtures).map((universe) => {
      const items = project.fixtures
        .filter((f) => f.universe === universe)
        .map((f) => ({ id: f.id, name: f.name, s: status.get(f.id) }));
      const used = new Set<number>();
      for (const it of items) {
        if (!it.s?.range) continue;
        for (let ch = it.s.range.start; ch <= Math.min(it.s.range.end, DMX_CHANNELS); ch += 1) used.add(ch);
      }
      const conflicts = items.filter((it) => (it.s?.conflictsWith.length ?? 0) > 0).length;
      return { universe, items, usedChannels: used.size, conflicts };
    });
  }, [project]);

  if (rows.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((row) => (
        <li key={row.universe} className="flex items-center gap-2">
          <span className="num w-10 shrink-0 text-xs text-muted-foreground">U{row.universe}</span>
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
            {row.items.map((it) => {
              const range = it.s?.range;
              if (!range) return null;
              const conflict = (it.s?.conflictsWith.length ?? 0) > 0 || it.s?.overflow;
              return (
                <span
                  key={it.id}
                  title={it.name}
                  className={cn(
                    "absolute inset-y-0 border-r border-background/60",
                    conflict ? "bg-destructive/80" : "bg-primary/60",
                    selectedIds.includes(it.id) && "ring-1 ring-inset ring-foreground",
                  )}
                  style={{
                    left: `${((range.start - 1) / DMX_CHANNELS) * 100}%`,
                    width: `${((Math.min(range.end, DMX_CHANNELS) - range.start + 1) / DMX_CHANNELS) * 100}%`,
                  }}
                />
              );
            })}
          </div>
          <span className="num w-14 shrink-0 text-right text-xs text-muted-foreground">
            {row.usedChannels}/{DMX_CHANNELS}
          </span>
        </li>
      ))}
    </ul>
  );
}

import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { summarizeOverview, type Overview } from "@/features/recording";

interface UniversePickerProps {
  /** 源节目的全部 Universe */
  all: readonly number[];
  /** 保留的 Universe */
  kept: readonly number[];
  overview: Overview | undefined;
  onToggle: (universe: number) => void;
  onSet: (universes: readonly number[]) => void;
}

/**
 * 选择要保留的 Universe：每项带活动占比（有变化的时间比例），并提供“全选”“只保留有数据的”。
 * 至少保留一个 Universe 才能导出。
 */
export function UniversePicker({ all, kept, overview, onToggle, onSet }: UniversePickerProps) {
  const { t } = useTranslation();
  const activity = useMemo(() => {
    const m = new Map<number, { share: number; peak: number }>();
    if (overview) for (const r of summarizeOverview(overview)) m.set(r.universe, { share: r.activeShare, peak: r.peakLevel });
    return m;
  }, [overview]);
  const withData = all.filter((u) => (activity.get(u)?.peak ?? 1) > 0);

  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 flex w-full items-center justify-between gap-2 text-sm font-medium">
        <span>
          {t("library.editUniverses")}
          <span className="num ml-2 text-xs font-normal text-muted-foreground">
            {t("library.editUniversesCount", { kept: kept.length, total: all.length })}
          </span>
        </span>
        <span className="flex gap-1">
          <Button size="sm" variant="ghost" className="h-8 px-2" onClick={() => onSet(all)}>
            {t("library.editUniversesAll")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 px-2"
            disabled={!overview || withData.length === 0}
            onClick={() => onSet(withData)}
          >
            {t("library.editUniversesWithData")}
          </Button>
        </span>
      </legend>
      <ul className="grid max-h-52 grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-1 overflow-y-auto">
        {all.map((u) => {
          const a = activity.get(u);
          const share = Math.round((a?.share ?? 0) * 100);
          return (
            <li key={u}>
              <label className="flex h-10 cursor-pointer items-center gap-2 rounded-md px-2 hover:bg-accent/50">
                <Checkbox checked={kept.includes(u)} onCheckedChange={() => onToggle(u)} />
                <span className="num text-sm">U{u}</span>
                {a && (
                  <span className="ml-auto flex items-center gap-1.5" title={t("library.editUniverseActivity", { share })}>
                    <span aria-hidden className="h-1.5 w-10 overflow-hidden rounded-full bg-muted">
                      <span className="block h-full bg-primary" style={{ width: `${share}%` }} />
                    </span>
                    <span className="num w-9 text-right text-xs text-muted-foreground">
                      {a.peak === 0 ? t("library.editUniverseIdle") : `${share}%`}
                    </span>
                  </span>
                )}
              </label>
            </li>
          );
        })}
      </ul>
      {kept.length === 0 && (
        <p role="alert" className="text-xs text-destructive">
          {t("library.errNoUniverses")}
        </p>
      )}
    </fieldset>
  );
}

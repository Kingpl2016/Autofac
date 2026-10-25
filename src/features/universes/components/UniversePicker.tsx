import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface UniversePickerProps {
  /** 可选的活跃 Universe 列表 */
  available: number[];
  /** 已选 Universe */
  selected: number[];
  /** 切换单个 */
  onToggle: (u: number) => void;
  /** 全选 */
  onSelectAll: (all: number[]) => void;
  /** 全不选 */
  onClear: () => void;
}

/**
 * Universe 多选器：活跃 Universe 作为可切换 chip，支持全选/全不选。
 */
export function UniversePicker({
  available,
  selected,
  onToggle,
  onSelectAll,
  onClear,
}: UniversePickerProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-muted-foreground">{t("universes.picker")}:</span>
      {available.length === 0 ? (
        <span className="text-sm text-muted-foreground">
          {t("dashboard.noActiveUniverses")}
        </span>
      ) : (
        <>
          {available.map((u) => {
            const active = selected.includes(u);
            return (
              <button
                key={u}
                type="button"
                onClick={() => onToggle(u)}
                aria-pressed={active}
                className={cn(
                  "tabular flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "border-primary bg-primary/15 text-primary"
                    : "border-border text-muted-foreground hover:bg-accent",
                )}
              >
                {active && <Check className="size-3" aria-hidden />}
                {u}
              </button>
            );
          })}
          <Button variant="ghost" size="sm" onClick={() => onSelectAll(available)}>
            {t("universes.selectAll")}
          </Button>
          <Button variant="ghost" size="sm" onClick={onClear}>
            {t("universes.deselectAll")}
          </Button>
        </>
      )}
    </div>
  );
}

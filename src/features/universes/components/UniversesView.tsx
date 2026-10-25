import { useTranslation } from "react-i18next";
import { TriangleAlert } from "lucide-react";

import { PageHeader } from "@/shared/components/PageHeader";
import { useEngineDataStore } from "@/shared/stores/engineDataStore";
import { useSettingsQuery } from "@/features/settings";
import { UniversePicker } from "./UniversePicker";
import { ChannelGrid } from "./ChannelGrid";
import { useViewedUniverses } from "../hooks/useViewedUniverses";

/** 同时显示的 Universe 数超过此值给出性能提示。 */
const PERF_WARN_THRESHOLD = 16;

/**
 * Universe 视图：多选器 + 各选中 Universe 的 512 通道实时色块栅格。
 */
export function UniversesView() {
  const { t } = useTranslation();
  const universes = useEngineDataStore((s) => s.universes);
  const settings = useSettingsQuery();
  const valueFormat = settings.data?.display.valueFormat ?? "decimal";
  const { selected, toggle, selectAll, clear } = useViewedUniverses();

  const available = universes.map((u) => u.universe);

  return (
    <div>
      <PageHeader title={t("universes.title")} subtitle={t("universes.subtitle")} />

      <div className="mb-(--density-gutter) rounded-lg border border-border bg-card p-8">
        <UniversePicker
          available={available}
          selected={selected}
          onToggle={toggle}
          onSelectAll={selectAll}
          onClear={clear}
        />
      </div>

      {selected.length >= PERF_WARN_THRESHOLD && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning">
          <TriangleAlert className="size-4" aria-hidden />
          {t("universes.perfWarning")}
        </div>
      )}

      {selected.length === 0 ? (
        <div className="flex h-48 items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
          {t("universes.noSelection")}
        </div>
      ) : (
        <div className="grid gap-(--density-gutter) xl:grid-cols-2">
          {selected.map((u) => (
            <ChannelGrid key={u} universe={u} valueFormat={valueFormat} />
          ))}
        </div>
      )}
    </div>
  );
}

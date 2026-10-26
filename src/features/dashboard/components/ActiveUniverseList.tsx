import { useTranslation } from "react-i18next";
import { LayoutGrid, Table2 } from "lucide-react";

import { SurfacePanel } from "@/shared/components/SurfacePanel";
import { Segmented } from "@/shared/components/Segmented";
import { useEngineDataStore } from "@/shared/stores/engineDataStore";
import { useProtocolFlags, useSettingsQuery } from "@/features/settings";
import { useDashboardPrefs } from "../stores/useDashboardPrefs";
import { visibleUniverses, type UniverseViewMode } from "../lib/universeView";
import { UniverseCard } from "./UniverseCard";
import { UniverseTable } from "./UniverseTable";

/**
 * 活动宇宙：卡片（默认）与表格两种视图。卡片视图为避免宇宙过多时渲染过重，
 * 超过上限后提示改用表格。
 */
export function ActiveUniverseList() {
  const { t } = useTranslation();
  const universes = useEngineDataStore((s) => s.universes);
  const { sacnEnabled } = useProtocolFlags();
  const { data: settings } = useSettingsQuery();
  const mergeMode = settings?.merge.mode ?? "htp";
  const view = useDashboardPrefs((s) => s.universeView);
  const setView = useDashboardPrefs((s) => s.setUniverseView);
  const { items, hidden } = visibleUniverses(universes, view);

  return (
    <SurfacePanel
      title={
        <>
          {t("dashboard.activeUniverseList")}{" "}
          <span className="tabular font-normal text-muted-foreground">({universes.length})</span>
        </>
      }
      actions={
        <Segmented<UniverseViewMode>
          value={view}
          onChange={setView}
          ariaLabel={t("dashboard.view.label")}
          options={[
            {
              value: "cards",
              label: t("dashboard.view.cards"),
              icon: <LayoutGrid className="size-3.5" aria-hidden />,
            },
            {
              value: "table",
              label: t("dashboard.view.table"),
              icon: <Table2 className="size-3.5" aria-hidden />,
            },
          ]}
        />
      }
    >
      {universes.length === 0 ? (
        <div className="py-6 text-center text-sm text-muted-foreground">
          {t("dashboard.noActiveUniverses")}
        </div>
      ) : view === "cards" ? (
        <>
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {items.map((u) => (
              <UniverseCard
                key={u.universe}
                universe={u}
                mergeMode={mergeMode}
                showProtocol={sacnEnabled}
              />
            ))}
          </ul>
          {hidden > 0 && (
            <p className="mt-3 text-center text-xs text-muted-foreground" role="note">
              {t("dashboard.cardLimit", { shown: items.length, total: universes.length })}
            </p>
          )}
        </>
      ) : (
        <UniverseTable universes={items} mergeMode={mergeMode} showProtocol={sacnEnabled} />
      )}
    </SurfacePanel>
  );
}
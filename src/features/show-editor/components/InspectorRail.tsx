import { useTranslation } from "react-i18next";
import { Lamp, PanelRightOpen, SlidersHorizontal, SquarePen, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { expandPanel } from "../hooks/panelControl";
import { INSPECTOR_TABS, useEditorUiStore, type InspectorTab } from "../stores/useEditorUiStore";

/** 属性面板收起后窄边的宽度（像素）。 */
export const INSPECTOR_RAIL_PX = 36;

/** 每个属性标签页在窄边上的图标。 */
const ICONS: Record<InspectorTab, LucideIcon> = {
  patch: Lamp,
  program: SlidersHorizontal,
  cue: SquarePen,
};

/**
 * 属性面板收起后的窄边（VS Code 式）：展开按钮 + 竖排的三个标签，点哪个就展开到哪一页；
 * 当前标签高亮（时间线点轨道头时会切到“灯具与 Patch”，这里随之亮起）。
 */
export function InspectorRail() {
  const { t } = useTranslation();
  const tab = useEditorUiStore((s) => s.inspectorTab);
  const setTab = useEditorUiStore((s) => s.setInspectorTab);
  const open = (to: InspectorTab) => {
    setTab(to);
    expandPanel("inspector");
  };

  return (
    <nav
      aria-label={t("editor.inspector.collapsedRail")}
      className="flex h-full flex-col items-center gap-1 border-l border-border bg-surface-1 py-1.5"
    >
      <button
        type="button"
        aria-label={t("editor.inspector.expand")}
        title={t("editor.inspector.expand")}
        onClick={() => expandPanel("inspector")}
        className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-3 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <PanelRightOpen aria-hidden className="size-4" />
      </button>
      <span aria-hidden className="my-0.5 h-px w-5 bg-border" />
      {INSPECTOR_TABS.map((id) => {
        const Icon = ICONS[id];
        const current = id === tab;
        const label = t(`editor.inspector.${id}`);
        return (
          <button
            key={id}
            type="button"
            aria-current={current ? "page" : undefined}
            aria-label={t("editor.inspector.openTab", { name: label })}
            title={t("editor.inspector.openTab", { name: label })}
            onClick={() => open(id)}
            className={cn(
              "relative flex w-7 flex-col items-center gap-1 rounded-md py-1.5 text-[11px] leading-none",
              "text-muted-foreground transition-colors duration-150 hover:bg-surface-3 hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              current && "bg-surface-3 text-foreground",
            )}
          >
            {current && <span aria-hidden className="absolute inset-y-1.5 -right-1 w-0.5 rounded-full bg-primary" />}
            <Icon aria-hidden className={cn("size-4", current && "text-primary")} />
            <span aria-hidden className="[writing-mode:vertical-rl]">
              {label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

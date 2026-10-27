import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { PANEL_WIDTH, usePanelPrefsStore } from "../stores/usePanelPrefsStore";
import { focusRingClass } from "./OptionTile";

/** 预设对应的名称 key，顺序与 `PANEL_WIDTH.presets` 一致。 */
const PRESET_KEYS = ["narrow", "medium", "wide"] as const;

/** 面板宽度三档预设：窄 / 中 / 宽。小屏上不显示（面板铺满屏幕）。 */
export function PanelWidthPresets() {
  const { t } = useTranslation();
  const width = usePanelPrefsStore((s) => s.width);
  const setWidth = usePanelPrefsStore((s) => s.setWidth);

  return (
    <fieldset className="m-0 hidden min-w-0 items-center gap-0.5 rounded-lg border border-border bg-muted/40 p-0.5 sm:flex">
      <legend className="sr-only">{t("appearance.panel.width")}</legend>
      {PANEL_WIDTH.presets.map((preset, index) => {
        const key = PRESET_KEYS[index] ?? "medium";
        const selected = width === preset;
        return (
          <button
            key={preset}
            type="button"
            aria-pressed={selected}
            onClick={() => setWidth(preset)}
            className={cn(
              focusRingClass,
              "rounded-md px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground",
              selected && "bg-background text-foreground shadow-sm",
            )}
          >
            {t(`appearance.panel.${key}`)}
          </button>
        );
      })}
    </fieldset>
  );
}

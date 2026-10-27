import { Check, ChevronDown, ShieldAlert, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { hexToOklch } from "@/shared/appearance/oklch";
import type { ThemePreset } from "@/shared/appearance/types";
import { cn } from "@/lib/utils";
import { useAppearancePresets } from "../hooks/useAppearancePresets";
import { useResolvedMode } from "../hooks/useResolvedMode";
import { useGroupTitle, usePresetLabel } from "../hooks/usePresetLabel";
import { getAccentContrast, MIN_TEXT_CONTRAST } from "../lib/accentContrast";
import { THEME_MODES, type ThemeMode } from "../lib/appearanceSettings";
import { groupPresets } from "../lib/groupPresets";
import { DEFAULT_THEME_ID } from "../lib/presets/builtinPresets";
import { getSwatch } from "../lib/themeSwatch";
import { setModeWithTransition } from "../lib/themeTransition";
import { useAppearanceStore } from "../stores/useAppearanceStore";
import { ColorPicker } from "./ColorPicker";
import { MiniWindow } from "./MiniWindow";
import { focusRingClass, OptionTile, selectedClass } from "./OptionTile";
import { SettingSection } from "./SettingSection";

/** 自定义取色器的初始颜色。 */
const FALLBACK_CUSTOM_COLOR = "#6366f1";

/** 判断一个颜色是否偏亮，用来决定叠在它上面的对勾用深色还是白色。 */
function isLightColor(hex: string): boolean {
  return (hexToOklch(hex)?.l ?? 0) > 0.74;
}

/** 明暗模式的预览：亮色与暗色各画一个迷你界面，“跟随系统”左右各取一半。 */
function ModePreview({ mode }: { mode: ThemeMode }) {
  const light = <MiniWindow swatch={getSwatch({}, "light")} className="h-14" />;
  const dark = <MiniWindow swatch={getSwatch({}, "dark")} className="h-14" />;
  if (mode === "light") return light;
  if (mode === "dark") return dark;
  return (
    <span className="relative block">
      {light}
      <span className="absolute inset-0 block" style={{ clipPath: "polygon(50% 0, 100% 0, 100% 100%, 50% 100%)" }}>
        {dark}
      </span>
    </span>
  );
}

/**
 * “颜色”标签页：明暗模式（含跟随系统）、整套主题、主色（色板、自定义取色与对比度）。
 */
export function ColorsTab() {
  const { t } = useTranslation();
  const getLabel = usePresetLabel();
  const getGroupTitle = useGroupTitle();
  const { themes, accents } = useAppearancePresets();
  const mode = useAppearanceStore((s) => s.mode);
  const theme = useAppearanceStore((s) => s.theme);
  const accent = useAppearanceStore((s) => s.accent);
  const update = useAppearanceStore((s) => s.update);
  const resolved = useResolvedMode();
  const [pickerOpen, setPickerOpen] = useState(false);

  const selectedThemeId = theme?.id ?? DEFAULT_THEME_ID;
  const contrast = accent ? getAccentContrast(accent.color, resolved) : null;
  const contrastOk = contrast !== null && contrast >= MIN_TEXT_CONTRAST;
  const accentName = (() => {
    if (!accent) return t("appearance.colors.accentDefault");
    if (accent.id === "custom") return t("appearance.colors.customAccent");
    const preset = accents.find((item) => item.id === accent.id);
    return preset ? getLabel(preset) : accent.id;
  })();

  return (
    <div className="space-y-8">
      <SettingSection title={t("appearance.colors.mode")} hint={t("appearance.colors.modeHint")}>
        <div className="grid grid-cols-3 gap-3">
          {THEME_MODES.map((value) => (
            <OptionTile
              key={value}
              selected={mode === value}
              onSelect={() => setModeWithTransition(value)}
              label={t(`theme.${value}`)}
              preview={<ModePreview mode={value} />}
            />
          ))}
        </div>
      </SettingSection>

      <SettingSection title={t("appearance.colors.theme")} hint={t("appearance.colors.themeHint")}>
        <div className="space-y-4">
          {groupPresets<ThemePreset>(themes, "more").map((group) => (
            <div key={group.key} className="space-y-2">
              <h4 className="text-xs font-medium text-muted-foreground">{getGroupTitle(group.key)}</h4>
              <div className="grid grid-cols-2 gap-3 min-[28rem]:grid-cols-3">
                {group.items.map((preset) => (
                  <OptionTile
                    key={preset.id}
                    selected={selectedThemeId === preset.id}
                    onSelect={() =>
                      update({
                        theme: preset.id === DEFAULT_THEME_ID ? null : { id: preset.id, tokens: preset.tokens },
                      })
                    }
                    label={getLabel(preset)}
                    preview={<MiniWindow swatch={getSwatch(preset.tokens[resolved], resolved)} />}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </SettingSection>

      <SettingSection title={t("appearance.colors.accent")} hint={t("appearance.colors.accentHint")}>
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-3">
          <span
            aria-hidden
            className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-primary text-sm font-semibold text-primary-foreground shadow-sm"
          >
            Aa
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <p className="truncate text-sm font-medium">
              <span className="sr-only">{t("appearance.colors.currentAccent")}：</span>
              {accentName}
            </p>
            {accent ? (
              <p className="font-mono text-xs uppercase text-muted-foreground">{accent.color}</p>
            ) : (
              <p className="text-xs text-muted-foreground">{t("appearance.colors.accentDefaultHint")}</p>
            )}
          </div>
          {contrast === null ? null : (
            <span
              className={cn(
                "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-xs font-medium tabular-nums",
                contrastOk ? "bg-success/15 text-success" : "bg-warning/15 text-warning",
              )}
            >
              {contrastOk ? <ShieldCheck aria-hidden className="size-3.5" /> : <ShieldAlert aria-hidden className="size-3.5" />}
              {t(contrastOk ? "appearance.colors.contrast" : "appearance.colors.contrastLow", { ratio: contrast.toFixed(1) })}
            </span>
          )}
          {accent ? (
            <Button variant="ghost" size="sm" onClick={() => update({ accent: null })}>
              {t("appearance.colors.accentReset")}
            </Button>
          ) : null}
        </div>

        <div className="grid grid-cols-8 justify-items-center gap-y-3">
          {accents.map((preset) => {
            const selected = accent?.id === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                aria-label={getLabel(preset)}
                aria-pressed={selected}
                title={getLabel(preset)}
                onClick={() => update({ accent: { id: preset.id, color: preset.color } })}
                className={cn(
                  focusRingClass,
                  "flex size-8 items-center justify-center rounded-full shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)] transition-transform hover:scale-110 motion-reduce:transition-none motion-reduce:hover:scale-100",
                  selected && "ring-2 ring-foreground/80 ring-offset-2 ring-offset-background",
                  isLightColor(preset.color) ? "text-black/70" : "text-white",
                )}
                style={{ background: preset.color }}
              >
                {selected ? <Check aria-hidden className="size-4" /> : null}
              </button>
            );
          })}
        </div>

        <div className={cn("overflow-hidden rounded-xl border border-border bg-card", accent?.id === "custom" && selectedClass)}>
          <button
            type="button"
            aria-expanded={pickerOpen}
            onClick={() => setPickerOpen((open) => !open)}
            className={cn(focusRingClass, "flex w-full items-center gap-2.5 p-3 text-left text-sm font-medium transition-colors hover:bg-accent")}
          >
            <span
              aria-hidden
              className="size-6 shrink-0 rounded-full shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)]"
              style={{
                background:
                  accent?.id === "custom"
                    ? accent.color
                    : "conic-gradient(#ef4444, #eab308, #22c55e, #06b6d4, #3b82f6, #d946ef, #ef4444)",
              }}
            />
            <span className="flex-1">{t("appearance.colors.customAccent")}</span>
            <ChevronDown
              aria-hidden
              className={cn("size-4 text-muted-foreground transition-transform motion-reduce:transition-none", pickerOpen && "rotate-180")}
            />
          </button>
          {pickerOpen ? (
            <div className="space-y-3 border-t border-border p-3">
              <ColorPicker
                value={accent?.color ?? FALLBACK_CUSTOM_COLOR}
                onChange={(color) => update({ accent: { id: "custom", color } })}
              />
              <p className="text-xs text-muted-foreground">{t("appearance.colors.customAccentHint")}</p>
            </div>
          ) : null}
        </div>
      </SettingSection>
    </div>
  );
}
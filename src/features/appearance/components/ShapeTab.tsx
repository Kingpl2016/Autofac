/** @file “形状与字体”标签页：圆角（预设与微调）、字体、界面缩放、界面密度 */
import { useTranslation } from "react-i18next";

import { Slider } from "@/components/ui/slider";
import { useAppearancePresets } from "../hooks/useAppearancePresets";
import type { FontPreset } from "@/shared/appearance/types";

import { DENSITIES, RADIUS_RANGE, SCALE_RANGE } from "../lib/appearanceSettings";
import { useAppearanceStore } from "../stores/useAppearanceStore";
import { DEFAULT_FONT_ID } from "../lib/presets/builtinPresets";
import { DensityGlyph, RadiusGlyph } from "./Glyphs";
import { groupPresets } from "../lib/groupPresets";
import { OptionTile } from "./OptionTile";
import { SettingSection } from "./SettingSection";
import { useGroupTitle, usePresetLabel } from "../hooks/usePresetLabel";

/** 圆角滑块的步长（rem） */
const RADIUS_STEP = 0.025;

/** 圆角预设（rem）：none / small / medium（应用默认）/ large / full */
const RADIUS_PRESETS = [
  { key: "none", value: 0 },
  { key: "small", value: 0.25 },
  { key: "medium", value: RADIUS_RANGE.defaultValue },
  { key: "large", value: 0.875 },
  { key: "full", value: RADIUS_RANGE.max },
] as const;

/** 两个圆角在多大误差内视为相同（rem） */
const RADIUS_EPSILON = 0.005;

/**
 * “形状与字体”标签页。
 *
 * @returns 形状与字体设置内容
 *
 * @example
 * ```tsx
 * <TabsContent value="shape">
 *   <ShapeTab />
 * </TabsContent>
 * ```
 */
export function ShapeTab() {
  const { t } = useTranslation();
  const getLabel = usePresetLabel();
  const getGroupTitle = useGroupTitle();
  const { fonts } = useAppearancePresets();
  const radius = useAppearanceStore((state) => state.radius);
  const font = useAppearanceStore((state) => state.font);
  const scale = useAppearanceStore((state) => state.scale);
  const density = useAppearanceStore((state) => state.density);
  const update = useAppearanceStore((state) => state.update);

  const radiusRem = radius ?? RADIUS_RANGE.defaultValue;
  const scalePercent = scale ?? SCALE_RANGE.defaultValue;
  const selectedFontId = font?.id ?? DEFAULT_FONT_ID;

  /**
   * 选择字体：先让预设有机会加载资源（失败不影响应用字体栈，浏览器会回退到后备字体）。
   *
   * @param preset - 字体预设
   */
  const selectFont = (preset: FontPreset) => {
    const apply = () =>
      update({
        font: preset.id === DEFAULT_FONT_ID ? null : { id: preset.id, sans: preset.sans, mono: preset.mono },
      });
    if (!preset.load) {
      apply();
      return;
    }
    void Promise.resolve(preset.load())
      .catch(() => {})
      .then(apply);
  };

  return (
    <div className="space-y-8">
      <SettingSection title={t("appearance.shape.radius")} hint={t("appearance.shape.radiusHint")}>
        <div className="grid grid-cols-5 gap-2">
          {RADIUS_PRESETS.map(({ key, value }) => (
            <OptionTile
              key={key}
              selected={Math.abs(radiusRem - value) < RADIUS_EPSILON}
              onSelect={() => update({ radius: value })}
              label={t(`appearance.shape.radiusPresets.${key}`)}
              preview={<RadiusGlyph rem={value} />}
              className="p-1.5"
            />
          ))}
        </div>
        <div className="flex items-center gap-3 rounded-xl border bg-card px-3 py-2.5">
          <Slider
            thumbLabel={t("appearance.shape.radiusSlider")}
            min={RADIUS_RANGE.min}
            max={RADIUS_RANGE.max}
            step={RADIUS_STEP}
            value={[radiusRem]}
            onValueChange={([value]) => {
              if (value !== undefined) update({ radius: value });
            }}
          />
          <output className="w-14 shrink-0 text-right text-sm text-muted-foreground tabular-nums">
            {t("appearance.shape.radiusValue", { value: Math.round(radiusRem * 16) })}
          </output>
        </div>
      </SettingSection>

      <SettingSection title={t("appearance.shape.font")} hint={t("appearance.shape.fontHint")}>
        <div className="space-y-4">
          {groupPresets(fonts).map((group) => (
            <div key={group.key} className="space-y-2">
              <h4 className="text-xs font-medium text-muted-foreground">{getGroupTitle(group.key)}</h4>
              <div className="grid grid-cols-2 gap-3">
                {group.items.map((preset) => (
                  <OptionTile
                    key={preset.id}
                    selected={selectedFontId === preset.id}
                    onSelect={() => selectFont(preset)}
                    label={getLabel(preset)}
                    preview={
                      <span
                        className="flex h-12 items-center rounded-lg bg-muted/60 px-3 text-lg leading-none"
                        style={{ fontFamily: preset.sans }}
                      >
                        {t("appearance.shape.fontSample")}
                      </span>
                    }
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </SettingSection>

      <SettingSection title={t("appearance.shape.scale")} hint={t("appearance.shape.scaleHint")}>
        <div className="flex items-center gap-3 rounded-xl border bg-card px-3 py-2.5">
          <span aria-hidden className="text-xs text-muted-foreground">
            A
          </span>
          <Slider
            thumbLabel={t("appearance.shape.scaleSlider")}
            min={SCALE_RANGE.min}
            max={SCALE_RANGE.max}
            step={SCALE_RANGE.step}
            value={[scalePercent]}
            onValueChange={([value]) => {
              if (value !== undefined) {
                update({ scale: value === SCALE_RANGE.defaultValue ? null : value });
              }
            }}
          />
          <span aria-hidden className="text-lg text-muted-foreground">
            A
          </span>
          <output className="w-12 shrink-0 text-right text-sm text-muted-foreground tabular-nums">
            {t("appearance.shape.scaleValue", { value: scalePercent })}
          </output>
        </div>
      </SettingSection>

      <SettingSection title={t("appearance.shape.density")} hint={t("appearance.shape.densityHint")}>
        <div className="grid grid-cols-3 gap-3">
          {DENSITIES.map((value) => (
            <OptionTile
              key={value}
              selected={density === value}
              onSelect={() => update({ density: value })}
              label={t(`appearance.shape.densityOptions.${value}`)}
              preview={<DensityGlyph density={value} />}
            />
          ))}
        </div>
      </SettingSection>
    </div>
  );
}

/** @file “卡片”标签页：卡片样式、阴影、圆角与内边距，顶部用真实的 Card 组件实时预览 */
import { useTranslation } from "react-i18next";

import { Slider } from "@/components/ui/slider";

import {
  CARD_BLUR_RANGE,
  CARD_BORDER_WIDTHS,
  CARD_HOVERS,
  CARD_PADDINGS,
  CARD_SHADOWS,
  CARD_STYLES,
  type CardStyle,
} from "../lib/appearanceSettings";
import { useAppearanceStore } from "../stores/useAppearanceStore";
import { CardStyleGlyph, PaddingGlyph, RadiusGlyph, ShadowGlyph } from "./Glyphs";
import { OptionTile } from "./OptionTile";
import { SettingSection } from "./SettingSection";
import { SwitchRow } from "./SwitchRow";

/** 卡片圆角预设（rem）；null 表示跟随全局圆角 */
const CARD_RADIUS_PRESETS = [
  { key: "none", value: 0 },
  { key: "small", value: 0.5 },
  { key: "medium", value: 1 },
  { key: "large", value: 1.5 },
  { key: "full", value: 2 },
] as const;

/** 两个圆角在多大误差内视为相同（rem） */
const RADIUS_EPSILON = 0.005;

/**
 * “卡片”标签页。
 *
 * @remarks
 * 设置通过 `<html>` 上的 data 属性与 CSS 变量作用于所有 `data-slot="card"` 的卡片，
 * 所以这里直接渲染真实的 Card 组件就能看到效果。
 *
 * @returns 卡片设置内容
 *
 * @example
 * ```tsx
 * <TabsContent value="cards">
 *   <CardsTab />
 * </TabsContent>
 * ```
 */
export function CardsTab() {
  const { t } = useTranslation();
  const cardStyle = useAppearanceStore((state) => state.cardStyle);
  const cardShadow = useAppearanceStore((state) => state.cardShadow);
  const cardRadius = useAppearanceStore((state) => state.cardRadius);
  const cardPadding = useAppearanceStore((state) => state.cardPadding);
  const cardHover = useAppearanceStore((state) => state.cardHover);
  const cardAccent = useAppearanceStore((state) => state.cardAccent);
  const cardBorderWidth = useAppearanceStore((state) => state.cardBorderWidth);
  const cardDividers = useAppearanceStore((state) => state.cardDividers);
  const cardGradientBorder = useAppearanceStore((state) => state.cardGradientBorder);
  const cardGlow = useAppearanceStore((state) => state.cardGlow);
  const cardBlur = useAppearanceStore((state) => state.cardBlur);
  const update = useAppearanceStore((state) => state.update);

  /**
   * 选择卡片样式。悬浮样式靠阴影区分层次，所以如果阴影还是默认的“轻”，顺手提到“中”。
   *
   * @param value - 目标样式
   */
  const selectStyle = (value: CardStyle) => {
    update({
      cardStyle: value,
      ...(value === "elevated" && cardShadow === "sm" ? { cardShadow: "md" } : {}),
    });
  };

  return (
    <div className="space-y-8">

      <SettingSection title={t("appearance.cards.style")} hint={t("appearance.cards.styleHint")}>
        <div className="grid grid-cols-3 gap-3 min-[26rem]:grid-cols-6">
          {CARD_STYLES.map((value) => (
            <OptionTile
              key={value}
              selected={cardStyle === value}
              onSelect={() => selectStyle(value)}
              label={t(`appearance.cards.styleOptions.${value}`)}
              preview={<CardStyleGlyph cardStyle={value} />}
              className="p-1.5"
            />
          ))}
        </div>
        {cardStyle === "glass" ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">{t("appearance.cards.glassHint")}</p>
            <div className="flex items-center gap-3 rounded-xl border bg-card px-3 py-2.5">
              <Slider
                thumbLabel={t("appearance.cards.blurSlider")}
                min={CARD_BLUR_RANGE.min}
                max={CARD_BLUR_RANGE.max}
                step={2}
                value={[cardBlur ?? CARD_BLUR_RANGE.defaultValue]}
                onValueChange={([value]) => {
                  if (value !== undefined) update({ cardBlur: value });
                }}
              />
              <output className="w-12 shrink-0 text-right text-sm text-muted-foreground tabular-nums">
                {cardBlur ?? CARD_BLUR_RANGE.defaultValue}px
              </output>
            </div>
          </div>
        ) : null}
      </SettingSection>

      <SettingSection title={t("appearance.cards.shadow")} hint={t("appearance.cards.shadowHint")}>
        <div className="grid grid-cols-4 gap-2">
          {CARD_SHADOWS.map((value) => (
            <OptionTile
              key={value}
              selected={cardShadow === value}
              onSelect={() => update({ cardShadow: value })}
              label={t(`appearance.cards.shadowOptions.${value}`)}
              preview={<ShadowGlyph shadow={value} />}
              disabled={cardStyle === "flat"}
              className="p-1.5"
            />
          ))}
        </div>
      </SettingSection>

      <SettingSection title={t("appearance.cards.radius")} hint={t("appearance.cards.radiusHint")}>
        <div className="grid grid-cols-3 gap-3">
          <OptionTile
            selected={cardRadius === null}
            onSelect={() => update({ cardRadius: null })}
            label={t("appearance.cards.radiusFollow")}
            preview={
              <span className="flex h-12 items-center justify-center rounded-lg bg-muted/60 text-xs text-muted-foreground">
                =
              </span>
            }
          />
          {CARD_RADIUS_PRESETS.map(({ key, value }) => (
            <OptionTile
              key={key}
              selected={cardRadius !== null && Math.abs(cardRadius - value) < RADIUS_EPSILON}
              onSelect={() => update({ cardRadius: value })}
              label={t(`appearance.shape.radiusPresets.${key}`)}
              preview={<RadiusGlyph rem={value} />}
            />
          ))}
        </div>
      </SettingSection>

      <SettingSection title={t("appearance.cards.padding")} hint={t("appearance.cards.paddingHint")}>
        <div className="grid grid-cols-3 gap-3">
          {CARD_PADDINGS.map((value) => (
            <OptionTile
              key={value}
              selected={cardPadding === value}
              onSelect={() => update({ cardPadding: value })}
              label={t(`appearance.cards.paddingOptions.${value}`)}
              preview={<PaddingGlyph padding={value} />}
            />
          ))}
        </div>
      </SettingSection>

      <SettingSection title={t("appearance.cards.border")} hint={t("appearance.cards.borderHint")}>
        <div className="grid grid-cols-3 gap-3">
          {CARD_BORDER_WIDTHS.map((value) => (
            <OptionTile
              key={value}
              selected={cardBorderWidth === value}
              onSelect={() => update({ cardBorderWidth: value })}
              label={`${value}px`}
              preview={
                <span className="flex h-12 items-center justify-center rounded-lg bg-muted/40">
                  <span
                    className="h-7 w-full rounded-md border-foreground/60 bg-card"
                    style={{ borderWidth: value }}
                  />
                </span>
              }
            />
          ))}
        </div>
        <div className="divide-y rounded-xl border bg-card">
          <SwitchRow
            label={t("appearance.cards.gradientBorder")}
            hint={t("appearance.cards.gradientBorderHint")}
            checked={cardGradientBorder}
            onCheckedChange={(checked) => update({ cardGradientBorder: checked })}
          />
          <SwitchRow
            label={t("appearance.cards.glow")}
            hint={t("appearance.cards.glowHint")}
            checked={cardGlow}
            onCheckedChange={(checked) => update({ cardGlow: checked })}
          />
        </div>
      </SettingSection>

      <SettingSection title={t("appearance.cards.hover")} hint={t("appearance.cards.hoverHint")}>
        <div className="grid grid-cols-3 gap-3">
          {CARD_HOVERS.map((value) => (
            <OptionTile
              key={value}
              selected={cardHover === value}
              onSelect={() => update({ cardHover: value })}
              label={t(`appearance.cards.hoverOptions.${value}`)}
            />
          ))}
        </div>
        <div className="divide-y rounded-xl border bg-card">
          <SwitchRow
            label={t("appearance.cards.dividers")}
            hint={t("appearance.cards.dividersHint")}
            checked={cardDividers}
            onCheckedChange={(checked) => update({ cardDividers: checked })}
          />
          <SwitchRow
            label={t("appearance.cards.accentBar")}
            hint={t("appearance.cards.accentBarHint")}
            checked={cardAccent}
            onCheckedChange={(checked) => update({ cardAccent: checked })}
          />
        </div>
      </SettingSection>
    </div>
  );
}

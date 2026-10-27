/** @file “特效”标签页：页面背景、按钮与内容的动效、骨架屏、滚动条与焦点环；全部默认关闭 */
import { MonitorIcon, PauseIcon, ZapIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

import {
  BACKGROUND_EFFECTS,
  BACKGROUND_INTENSITIES,
  BACKGROUND_SPEEDS,
  MOTIONS,
  type BackgroundEffect,
  type Motion,
} from "../lib/appearanceSettings";
import { useAppearanceStore } from "../stores/useAppearanceStore";
import { BackgroundSection } from "./BackgroundSection";
import { OptionTile } from "./OptionTile";
import { SettingSection } from "./SettingSection";
import { SwitchRow } from "./SwitchRow";

/** 动效偏好选项的图标 */
const MOTION_ICONS = {
  system: MonitorIcon,
  reduce: PauseIcon,
  full: ZapIcon,
} as const satisfies Record<Motion, typeof MonitorIcon>;

/** 背景特效示意：用与真实效果相近的渐变画出 */
const BACKGROUND_PREVIEW: Record<BackgroundEffect, string> = {
  none: "bg-muted/40",
  flow: "bg-[conic-gradient(from_0deg_at_50%_40%,color-mix(in_oklab,var(--primary)_30%,transparent),color-mix(in_oklab,var(--chart-2)_26%,transparent),color-mix(in_oklab,var(--chart-4)_26%,transparent),color-mix(in_oklab,var(--primary)_30%,transparent))]",
  aurora:
    "bg-[radial-gradient(60%_60%_at_15%_10%,color-mix(in_oklab,var(--primary)_35%,transparent),transparent_70%),radial-gradient(50%_50%_at_90%_20%,color-mix(in_oklab,var(--chart-2)_30%,transparent),transparent_70%)] bg-muted/30",
  dots: "bg-muted/30 bg-[radial-gradient(color-mix(in_oklab,var(--foreground)_30%,transparent)_1px,transparent_1px)] bg-size-[8px_8px]",
  grid: "bg-muted/30 bg-[linear-gradient(color-mix(in_oklab,var(--foreground)_14%,transparent)_1px,transparent_1px),linear-gradient(90deg,color-mix(in_oklab,var(--foreground)_14%,transparent)_1px,transparent_1px)] bg-size-[10px_10px]",
  grain: "bg-muted/60",
};

/**
 * “特效”标签页。
 *
 * @remarks
 * 动画类特效在“减少动画”下自动停用；背景特效不拦截指针事件，也不改变布局。
 *
 * @returns 特效设置内容
 *
 * @example
 * ```tsx
 * <TabsContent value="effects">
 *   <EffectsTab />
 * </TabsContent>
 * ```
 */
export function EffectsTab() {
  const { t } = useTranslation();
  const bgEffect = useAppearanceStore((state) => state.bgEffect);
  const bgAnimated = useAppearanceStore((state) => state.bgAnimated);
  const bgSpeed = useAppearanceStore((state) => state.bgSpeed);
  const bgIntensity = useAppearanceStore((state) => state.bgIntensity);
  const pressFeedback = useAppearanceStore((state) => state.pressFeedback);
  const entrance = useAppearanceStore((state) => state.entrance);
  const shimmer = useAppearanceStore((state) => state.shimmer);
  const thinScrollbar = useAppearanceStore((state) => state.thinScrollbar);
  const focusRing = useAppearanceStore((state) => state.focusRing);
  const pageTransition = useAppearanceStore((state) => state.pageTransition);
  const motionPref = useAppearanceStore((state) => state.motion);
  const update = useAppearanceStore((state) => state.update);

  return (
    <div className="space-y-8">
      <SettingSection
        title={t("appearance.effects.background")}
        hint={t("appearance.effects.backgroundHint")}
      >
        <div className="grid grid-cols-3 gap-3 min-[26rem]:grid-cols-6">
          {BACKGROUND_EFFECTS.map((value) => (
            <OptionTile
              key={value}
              selected={bgEffect === value}
              onSelect={() => update({ bgEffect: value })}
              label={t(`appearance.effects.backgroundOptions.${value}`)}
              preview={<span className={cn("block h-12 rounded-lg border", BACKGROUND_PREVIEW[value])} />}
              className="p-1.5"
            />
          ))}
        </div>
      </SettingSection>

      <SettingSection title={t("appearance.effects.motion")} hint={t("appearance.effects.motionHint")}>
        <div className="divide-y rounded-xl border bg-card">
          <SwitchRow
            label={t("appearance.effects.pressFeedback")}
            hint={t("appearance.effects.pressFeedbackHint")}
            checked={pressFeedback}
            onCheckedChange={(checked) => update({ pressFeedback: checked })}
          />
          <SwitchRow
            label={t("appearance.effects.entrance")}
            hint={t("appearance.effects.entranceHint")}
            checked={entrance}
            onCheckedChange={(checked) => update({ entrance: checked })}
          />
          <SwitchRow
            label={t("appearance.effects.shimmer")}
            hint={t("appearance.effects.shimmerHint")}
            checked={shimmer}
            onCheckedChange={(checked) => update({ shimmer: checked })}
          />
        </div>
        {bgEffect !== "none" ? (
          <div className="space-y-3">
            <div className="divide-y rounded-xl border bg-card">
              <SwitchRow
                label={t("appearance.effects.animated")}
                hint={t("appearance.effects.animatedHint")}
                checked={bgAnimated}
                onCheckedChange={(checked) => update({ bgAnimated: checked })}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <fieldset className="m-0 min-w-0 space-y-1.5 border-0 p-0">
                <legend className="mb-1.5 text-xs font-medium text-muted-foreground">
                  {t("appearance.effects.speed")}
                </legend>
                <div className="grid grid-cols-3 gap-1.5">
                  {BACKGROUND_SPEEDS.map((value) => (
                    <OptionTile
                      key={value}
                      selected={bgSpeed === value}
                      disabled={!bgAnimated}
                      onSelect={() => update({ bgSpeed: value })}
                      label={t(`appearance.effects.speedOptions.${value}`)}
                      className="p-1.5 text-center"
                    />
                  ))}
                </div>
              </fieldset>
              <fieldset className="m-0 min-w-0 space-y-1.5 border-0 p-0">
                <legend className="mb-1.5 text-xs font-medium text-muted-foreground">
                  {t("appearance.effects.intensity")}
                </legend>
                <div className="grid grid-cols-3 gap-1.5">
                  {BACKGROUND_INTENSITIES.map((value) => (
                    <OptionTile
                      key={value}
                      selected={bgIntensity === value}
                      onSelect={() => update({ bgIntensity: value })}
                      label={t(`appearance.effects.intensityOptions.${value}`)}
                      className="p-1.5 text-center"
                    />
                  ))}
                </div>
              </fieldset>
            </div>
          </div>
        ) : null}
      </SettingSection>

      <BackgroundSection />

      <SettingSection
        title={t("appearance.effects.motionPref")}
        hint={t("appearance.effects.motionPrefHint")}
      >
        <div className="grid grid-cols-3 gap-3">
          {MOTIONS.map((value) => {
            const Icon = MOTION_ICONS[value];
            return (
              <OptionTile
                key={value}
                selected={motionPref === value}
                onSelect={() => update({ motion: value })}
                label={t(`appearance.effects.motionOptions.${value}`)}
                preview={
                  <span className="flex h-12 items-center justify-center rounded-lg bg-muted/60 text-foreground/70">
                    <Icon className="size-5" />
                  </span>
                }
              />
            );
          })}
        </div>
        <div className="divide-y rounded-xl border bg-card">
          <SwitchRow
            label={t("appearance.effects.pageTransition")}
            hint={t("appearance.effects.pageTransitionHint")}
            checked={pageTransition}
            onCheckedChange={(checked) => update({ pageTransition: checked })}
          />
        </div>
      </SettingSection>

      <SettingSection title={t("appearance.effects.details")}>
        <div className="divide-y rounded-xl border bg-card">
          <SwitchRow
            label={t("appearance.effects.thinScrollbar")}
            hint={t("appearance.effects.thinScrollbarHint")}
            checked={thinScrollbar}
            onCheckedChange={(checked) => update({ thinScrollbar: checked })}
          />
          <SwitchRow
            label={t("appearance.effects.focusRing")}
            hint={t("appearance.effects.focusRingHint")}
            checked={focusRing === "strong"}
            onCheckedChange={(checked) => update({ focusRing: checked ? "strong" : "keyboard" })}
          />
        </div>
      </SettingSection>
    </div>
  );
}

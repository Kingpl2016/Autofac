import { useId } from "react";
import { useTranslation } from "react-i18next";
import { useDraggable } from "@dnd-kit/core";
import { Activity, AudioWaveform, Blend, ChevronsRight, MoveRight, Rainbow, Sparkles, Zap, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { announce } from "@/shared/stores/announcerStore";
import { useCueActions } from "../hooks/useCueActions";
import { supportedTargets, useTargetCapabilities } from "../hooks/useTargetCapabilities";
import { applicability, effectNeeds, type Applicability } from "../lib/cueDefaults";
import { addEffectCue } from "../lib/cueOps";
import { effectBackground } from "../lib/cueTemplates";
import { EFFECT_PRESETS, type EffectPreset } from "../lib/effectPresets";
import type { EffectId } from "../lib/project";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";
import { ApplyBadge } from "./ApplyBadge";
import { EffectLibrarySection } from "./EffectLibrarySection";

/** 拖拽数据：标明被拖的是特效预设。 */
export interface EffectDragData {
  kind: "effect";
  preset: EffectPreset;
}

/** 各特效在素材库里的图标。 */
const ICONS: Record<EffectId, LucideIcon> = {
  breathe: AudioWaveform,
  rainbow: Rainbow,
  chase: MoveRight,
  wipe: ChevronsRight,
  gradient: Blend,
  pulse: Activity,
  sparkle: Sparkles,
  strobe: Zap,
};

/** 特效芯片：图标 + 名称（+ 适用提示）。 */
export function EffectChip({
  preset,
  overlay,
  app,
  badgeId,
}: {
  preset: EffectPreset;
  overlay?: boolean;
  app?: Applicability | null;
  badgeId?: string;
}) {
  const { t } = useTranslation();
  const Icon = ICONS[preset.effect];
  // 色块与放到时间线后的片段主体同一画法（彩虹 / 渐变按周期，取一个默认长度的缩略）
  const swatch = effectBackground({ ...preset.params, startMs: 0, endMs: preset.lengthMs });
  return (
    <span
      className={cn(
        "flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-2 text-sm",
        overlay && "border-primary shadow-lg",
        app?.level === "none" && "opacity-50",
      )}
    >
      <Icon className="size-4 shrink-0 text-clip-effect" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{t(`editor.effects.${preset.effect}`)}</span>
      <span aria-hidden data-testid="effect-swatch" className="h-3 w-6 shrink-0 rounded-sm border border-border" style={{ background: swatch }} />
      <ApplyBadge app={app ?? null} id={badgeId} />
    </span>
  );
}

/** 一个特效：可以用指针拖到轨道上，也可以点击（键盘 Enter / 空格）加到所选轨道的播放头处。 */
function DraggableEffect({
  preset,
  app,
  onActivate,
}: {
  preset: EffectPreset;
  app: Applicability | null;
  onActivate: () => void;
}) {
  const { t } = useTranslation();
  const badgeId = useId();
  const data: EffectDragData = { kind: "effect", preset };
  const { setNodeRef, listeners, isDragging } = useDraggable({ id: `effect:${preset.effect}`, data });
  return (
    <button
      ref={setNodeRef}
      type="button"
      {...listeners}
      onClick={onActivate}
      title={t(`editor.effects.${preset.effect}Hint`)}
      aria-label={t(`editor.effects.${preset.effect}`)}
      aria-describedby={app && app.level !== "full" ? badgeId : undefined}
      className={cn(
        "w-full cursor-grab rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isDragging && "opacity-40",
      )}
    >
      <EffectChip preset={preset} app={app} badgeId={badgeId} />
    </button>
  );
}

/**
 * 素材库的“特效”标签：属性特效库（配置文件加载的外观片段，可叠加、按拍）+ 8 种经典 RGB 特效。
 *
 * 拖到轨道上放下，或点击把它加到所选轨道（没有选中轨道时用第一条未锁定的轨道）的播放头处；
 * 放在分组轨道上时，特效会沿分组里灯具的顺序推进。
 */
export function EffectsTab() {
  const { t } = useTranslation();
  const actions = useCueActions();
  const caps = useTargetCapabilities();

  const addToSelectedTrack = (preset: EffectPreset) => {
    const needs = effectNeeds(preset);
    const { all, supported: trackIds } = supportedTargets(useProjectStore.getState().project, useEditorUiStore.getState(), needs);
    if (all.length === 0) {
      announce(t("editor.templates.noTrack"));
      return;
    }
    if (trackIds.length === 0) {
      announce(t("editor.apply.rejected", { reason: t(`editor.apply.needs.${needs}`) }));
      return;
    }
    const { playheadMs } = useEditorUiStore.getState();
    const created = actions.insertOnTracks(trackIds, (d, trackId) => addEffectCue(d, trackId, playheadMs, preset));
    if (created.length > 0) useEditorUiStore.getState().setInspectorTab("cue");
    if (trackIds.length === 1) announce(created.length > 0 ? t("editor.effects.added") : t("editor.templates.noRoom"));
  };

  return (
    <div className="flex flex-col gap-4 p-2">
      <EffectLibrarySection caps={caps} />
      <section aria-label={t("editor.effects.classic")} className="flex flex-col gap-2">
        <h3 className="px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">{t("editor.effects.classic")}</h3>
        <p className="px-1 text-xs text-muted-foreground">{t("editor.effects.hint")}</p>
        <ul className="grid grid-cols-2 gap-1.5">
          {EFFECT_PRESETS.map((preset) => (
            <li key={preset.effect}>
              <DraggableEffect
                preset={preset}
                app={caps.length > 0 ? applicability(caps, effectNeeds(preset)) : null}
                onActivate={() => addToSelectedTrack(preset)}
              />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

import { useTranslation } from "react-i18next";
import { useDraggable } from "@dnd-kit/core";
import {
  Activity,
  AudioWaveform,
  Blend,
  ChevronsRight,
  MoveRight,
  Rainbow,
  Sparkles,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { announce } from "@/shared/stores/announcerStore";
import { useCueActions } from "../hooks/useCueActions";
import { EFFECT_PRESETS, type EffectPreset } from "../lib/effectPresets";
import type { EffectId } from "../lib/project";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";

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

/** 特效芯片：图标 + 名称。 */
export function EffectChip({ preset, overlay }: { preset: EffectPreset; overlay?: boolean }) {
  const { t } = useTranslation();
  const Icon = ICONS[preset.effect];
  return (
    <span
      className={cn(
        "flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-2 text-sm",
        overlay && "border-primary shadow-lg",
      )}
    >
      <Icon className="size-4 shrink-0 text-primary" aria-hidden />
      <span className="truncate">{t(`editor.effects.${preset.effect}`)}</span>
    </span>
  );
}

/** 一个特效：可以用指针拖到轨道上，也可以点击（键盘 Enter / 空格）加到所选轨道的播放头处。 */
function DraggableEffect({ preset, onActivate }: { preset: EffectPreset; onActivate: () => void }) {
  const { t } = useTranslation();
  const data: EffectDragData = { kind: "effect", preset };
  const { setNodeRef, listeners, isDragging } = useDraggable({ id: `effect:${preset.effect}`, data });
  return (
    <button
      ref={setNodeRef}
      type="button"
      {...listeners}
      onClick={onActivate}
      title={t(`editor.effects.${preset.effect}Hint`)}
      className={cn(
        "cursor-grab rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isDragging && "opacity-40",
      )}
    >
      <EffectChip preset={preset} />
    </button>
  );
}

/**
 * 素材库的“特效”标签：8 种参数化特效。
 *
 * 拖到轨道上放下，或点击把它加到所选轨道（没有选中轨道时用第一条未锁定的轨道）的播放头处；
 * 放在分组轨道上时，特效会沿分组里灯具的顺序推进。
 */
export function EffectsTab() {
  const { t } = useTranslation();
  const actions = useCueActions();

  const addToSelectedTrack = (preset: EffectPreset) => {
    const { tracks } = useProjectStore.getState().project;
    const { selectedTrackId, playheadMs } = useEditorUiStore.getState();
    const track =
      tracks.find((tr) => tr.id === selectedTrackId && !tr.lock) ?? tracks.find((tr) => !tr.lock);
    if (!track) {
      announce(t("editor.templates.noTrack"));
      return;
    }
    const id = actions.addEffectAt(track.id, playheadMs, preset);
    if (id) useEditorUiStore.getState().setInspectorTab("cue");
    announce(id ? t("editor.effects.added") : t("editor.templates.noRoom"));
  };

  return (
    <div className="flex flex-col gap-2 p-2">
      <p className="px-1 text-xs text-muted-foreground">{t("editor.effects.hint")}</p>
      <ul className="grid grid-cols-2 gap-1.5">
        {EFFECT_PRESETS.map((preset) => (
          <li key={preset.effect}>
            <DraggableEffect preset={preset} onActivate={() => addToSelectedTrack(preset)} />
          </li>
        ))}
      </ul>
    </div>
  );
}

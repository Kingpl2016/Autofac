import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { Layers } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Segmented } from "@/shared/components/Segmented";
import { announce } from "@/shared/stores/announcerStore";
import { CONVERTIBLE_EFFECTS, lookFromLegacyEffect } from "../lib/attrEffects";
import {
  convertToLook,
  replaceWithLook,
  setCueTimes,
  updateCues,
  updateEffectCues,
  type CuePatch,
  type EffectPatch,
} from "../lib/cueOps";
import { setCueLengths } from "../lib/editOps";
import { trackFixtureIds, trackName } from "../lib/ops";
import type { Cue, Easing, EffectCue, LookClip } from "../lib/project";
import { formatTimecode, parseTimecode } from "../lib/time";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";
import { CommitInput } from "./CommitInput";
import { ColorSection } from "./ColorSection";
import { EffectInspector } from "./EffectInspector";
import { EmptyHint } from "./EmptyHint";
import { LookInspector } from "./LookInspector";
import { SceneInspector } from "./SceneInspector";
import { SliderField } from "./SliderField";

const EASINGS: readonly Easing[] = ["linear", "easeInOut", "sCurve"];

/**
 * 一批 Cue 在某个属性上的共同值。
 *
 * @param cues 选中的 Cue。
 * @param pick 取属性的函数。
 * @returns 第一个 Cue 的值，以及这批 Cue 的值是否不一致。
 */
function common<T>(cues: readonly Cue[], pick: (c: Cue) => T): { value: T; mixed: boolean } {
  const first = pick(cues[0]);
  const key = (v: T) => JSON.stringify(v);
  return { value: first, mixed: cues.some((c) => key(pick(c)) !== key(first)) };
}

/**
 * Cue 属性面板：编辑选中 Cue 的颜色、亮度、淡入淡出、缓动曲线和起止时间。
 *
 * 选中多个 Cue 时批量修改（时间字段隐藏）；各字段在“松手 / 失焦 / Enter”时提交一次，
 * 一次提交对应一步撤销。特效 Cue 没有固定颜色，颜色区不显示，改为显示特效参数（见 `EffectInspector`）。
 */
export function CueInspector() {
  const { t } = useTranslation();
  const project = useProjectStore((s) => s.project);
  const update = useProjectStore((s) => s.update);
  const selectedIds = useEditorUiStore((s) => s.selectedCueIds);

  const selected = useMemo(() => {
    const wanted = new Set(selectedIds);
    return project.cues.filter((c) => wanted.has(c.id));
  }, [project.cues, selectedIds]);

  if (selected.length === 0) return <EmptyHint>{t("editor.inspector.empty")}</EmptyHint>;

  const ids = selected.map((c) => c.id);
  const patch = (changes: CuePatch) => update((d) => void updateCues(d, ids, changes));
  const single = selected.length === 1 ? selected[0] : null;
  const statics = selected.filter((c) => c.kind === "static");
  const effects = selected.filter((c): c is EffectCue => c.kind === "effect");
  const looks = selected.filter((c): c is LookClip => c.kind === "look");
  const effectIds = effects.map((c) => c.id);
  const locked = selected.every((c) => project.tracks.find((tr) => tr.id === c.trackId)?.lock);
  const brightness = common(selected, (c) => c.brightness);
  const fadeIn = common(selected, (c) => c.fadeInMs);
  const fadeOut = common(selected, (c) => c.fadeOutMs);
  const easing = common(selected, (c) => c.easing);
  const shortest = Math.min(...selected.map((c) => c.endMs - c.startMs));
  const mixedLabel = t("editor.cue.mixed");
  const ownerTrack = single ? project.tracks.find((tr) => tr.id === single.trackId) : undefined;

  return (
    <div className="flex flex-col gap-4 p-3">
      <header>
        <h3 className="text-sm font-medium">
          {single
            ? (ownerTrack ? trackName(project, ownerTrack) : "") || t("editor.timeline.missingTarget")
            : t("editor.cue.selectedCount", { count: selected.length })}
        </h3>
        {locked && <p className="mt-1 text-xs text-warning">{t("editor.cue.locked")}</p>}
        {!single && !locked && (
          <label className="mt-2 flex items-center justify-between gap-2 text-sm">
            <span>{t("editor.cue.sameLength")}</span>
            <CommitInput
              label={t("editor.cue.sameLength")}
              value={(() => {
                const len = common(selected, (c) => formatTimecode(c.endMs - c.startMs));
                return len.mixed ? "" : len.value;
              })()}
              inputMode="numeric"
              className="num h-7 w-24 px-1.5 text-xs"
              onCommit={(text) => {
                const ms = parseTimecode(text);
                if (ms === null) return;
                let n = 0;
                update((d) => {
                  n = setCueLengths(d, ids, ms);
                });
                announce(t("editor.cue.lengthSet", { count: n, time: formatTimecode(ms) }));
              }}
            />
          </label>
        )}
      </header>

      {looks.length > 0 && <LookInspector cues={looks} />}

      {single?.kind === "scene" && <SceneInspector cue={single} />}

      {statics.length > 0 && !locked && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 justify-start"
          title={t("editor.look.convertHint")}
          onClick={() => {
            let n = 0;
            update((d) => {
              n = convertToLook(d, statics.map((c) => c.id));
            });
            announce(t("editor.look.converted", { count: n }));
          }}
        >
          <Layers aria-hidden />
          {t("editor.look.convert", { count: statics.length })}
        </Button>
      )}

      {statics.length > 0 && (
        <ColorSection
          key={ids.join(",")}
          rgb={statics[0].kind === "static" ? statics[0].rgb : [255, 255, 255]}
          mixed={common(statics, (c) => (c.kind === "static" ? c.rgb : null)).mixed}
          onCommit={(rgb) => patch({ rgb })}
        />
      )}

      {effects.some((c) => CONVERTIBLE_EFFECTS.has(c.effect)) && !locked && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 justify-start"
          title={t("editor.attrEffects.convertHint")}
          onClick={() => {
            let n = 0;
            update((d) => {
              for (const c of effects) {
                const track = d.tracks.find((tr) => tr.id === c.trackId);
                const members = track ? trackFixtureIds(d, track).length : 1;
                const converted = lookFromLegacyEffect(c, members, d.tempo);
                if (converted && replaceWithLook(d, c.id, converted.look, converted.spread)) n += 1;
              }
            });
            announce(t("editor.attrEffects.converted", { count: n }));
          }}
        >
          <Layers aria-hidden />
          {t("editor.attrEffects.convert")}
        </Button>
      )}

      {effects.length > 0 && (
        <EffectInspector
          cues={effects}
          tempo={project.tempo}
          onPatch={(changes: EffectPatch) => update((d) => void updateEffectCues(d, effectIds, changes))}
        />
      )}

      <SliderField
        label={t("editor.cue.brightness")}
        numberLabel={t("editor.cue.numberOf", { field: t("editor.cue.brightness") })}
        value={brightness.value}
        min={0}
        max={100}
        unit="%"
        mixed={brightness.mixed}
        mixedLabel={mixedLabel}
        onCommit={(v) => patch({ brightness: v })}
      />
      <SliderField
        label={t("editor.cue.fadeIn")}
        numberLabel={t("editor.cue.numberOf", { field: t("editor.cue.fadeIn") })}
        value={fadeIn.value}
        min={0}
        max={Math.max(0, shortest)}
        step={10}
        unit="ms"
        mixed={fadeIn.mixed}
        mixedLabel={mixedLabel}
        onCommit={(v) => patch({ fadeInMs: v })}
      />
      <SliderField
        label={t("editor.cue.fadeOut")}
        numberLabel={t("editor.cue.numberOf", { field: t("editor.cue.fadeOut") })}
        value={fadeOut.value}
        min={0}
        max={Math.max(0, shortest)}
        step={10}
        unit="ms"
        mixed={fadeOut.mixed}
        mixedLabel={mixedLabel}
        onCommit={(v) => patch({ fadeOutMs: v })}
      />

      <div className="grid gap-1.5">
        <Label className="text-xs">
          {t("editor.cue.easing")}
          {easing.mixed && <span className="ml-1.5 text-muted-foreground">{mixedLabel}</span>}
        </Label>
        <Segmented<Easing>
          ariaLabel={t("editor.cue.easing")}
          value={easing.value}
          options={EASINGS.map((e) => ({ value: e, label: t(`editor.cue.easings.${e}`) }))}
          onChange={(e) => patch({ easing: e })}
        />
      </div>

      {single && (
        <TimeSection
          cue={single}
          onSetTimes={(start, end) => update((d) => void setCueTimes(d, single.id, start, end))}
        />
      )}
    </div>
  );
}

interface TimeSectionProps {
  cue: Cue;
  onSetTimes: (startMs: number, endMs: number) => void;
}

/** 时间区（仅单选）：起点、终点和长度，用时间码输入；非法或会重叠的输入被忽略。 */
function TimeSection({ cue, onSetTimes }: TimeSectionProps) {
  const { t } = useTranslation();
  const commit = (build: (ms: number) => [number, number]) => (text: string) => {
    const ms = parseTimecode(text);
    if (ms !== null) onSetTimes(...build(ms));
  };
  const length = cue.endMs - cue.startMs;
  return (
    <section aria-label={t("editor.cue.time")} className="grid grid-cols-3 gap-2">
      <label className="grid gap-1 text-xs text-muted-foreground">
        {t("editor.cue.start")}
        <CommitInput
          className="num h-8 px-2 text-sm"
          label={t("editor.cue.start")}
          value={formatTimecode(cue.startMs)}
          onCommit={commit((ms) => [ms, ms + length])}
        />
      </label>
      <label className="grid gap-1 text-xs text-muted-foreground">
        {t("editor.cue.end")}
        <CommitInput
          className="num h-8 px-2 text-sm"
          label={t("editor.cue.end")}
          value={formatTimecode(cue.endMs)}
          onCommit={commit((ms) => [cue.startMs, ms])}
        />
      </label>
      <label className="grid gap-1 text-xs text-muted-foreground">
        {t("editor.cue.duration")}
        <CommitInput
          className="num h-8 px-2 text-sm"
          label={t("editor.cue.duration")}
          value={formatTimecode(length)}
          onCommit={commit((ms) => [cue.startMs, cue.startMs + ms])}
        />
      </label>
    </section>
  );
}

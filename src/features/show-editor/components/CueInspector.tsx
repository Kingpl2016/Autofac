import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { Crosshair, Layers, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Segmented } from "@/shared/components/Segmented";
import { announce } from "@/shared/stores/announcerStore";
import { cssColor } from "../lib/cueTemplates";
import { colorValueRgb } from "../lib/looks";
import { clipName } from "../lib/clipVisual";
import { commonFx, convertLegacyEffects, detachFx, effectName, setFxParams } from "../lib/effectLibrary";
import {
  convertToLook,
  setCueLabel,
  setCueTimes,
  updateCues,
  updateEffectCues,
  type CuePatch,
  type EffectPatch,
} from "../lib/cueOps";
import { revealInPatch } from "../hooks/selectionActions";
import { setCueLengths } from "../lib/editOps";
import { selectionOfTracks } from "../lib/fixtureSelection";
import { trackFixtureIds, trackName } from "../lib/ops";
import { effectFromClip } from "../lib/effectDraft";
import { useEffectEditorStore } from "../stores/useEffectEditorStore";
import { allEffects, useEffectLibraryStore } from "../stores/useEffectLibraryStore";
import type { Cue, Easing, EffectCue, LookClip } from "../lib/project";
import { formatTimecode, parseTimecode } from "../lib/time";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";
import { CommitInput } from "./CommitInput";
import { ColorPicker } from "./ColorPicker";
import { EffectInspector } from "./EffectInspector";
import { EffectParamsPanel } from "./EffectParamsPanel";
import { EmptyHint } from "./EmptyHint";
import { InspectorSection } from "./InspectorSection";
import { LookInspector, LookKeyNav } from "./LookInspector";
import { SceneInspector } from "./SceneInspector";
import { SliderField } from "./SliderField";

const EASINGS: readonly Easing[] = ["linear", "easeInOut", "sCurve"];

/** 静态片段的色盘只提供彩色方式。 */
const RGB_ONLY = ["rgb"] as const;

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
 *
 * 布局与“灯具与 Patch”的详情一致：顶部是摘要（标题、所属灯具、锁定、外观片段的关键帧导航、转换操作），
 * 下面先是片段特有的分区（静态：颜色；特效：特效参数、特效颜色；外观：强度、颜色、属性层、多灯分布、
 * 复制粘贴；场景：场景条目），最后是共用的“亮度与淡入淡出”“时间”。分区展开状态记住，同名分区各类型共用。
 */
export function CueInspector() {
  const { t, i18n } = useTranslation();
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
  // 片段驱动的灯具：“在 Patch 中查看”直接跳过去
  const owner = (() => {
    const trackIds = [...new Set(selected.map((c) => c.trackId))];
    const { fixtureIds } = selectionOfTracks(project, trackIds);
    const target = trackIds.length === 1 ? project.tracks.find((tr) => tr.id === trackIds[0])?.target : undefined;
    const label =
      target?.kind === "fixture" && fixtureIds.length === 1
        ? t("editor.cue.ownerFixture", { name: project.fixtures.find((f) => f.id === fixtureIds[0])?.name ?? "" })
        : target?.kind === "group"
          ? t("editor.cue.ownerGroup", { name: project.groups.find((g) => g.id === target.id)?.name ?? "", count: fixtureIds.length })
          : t("editor.cue.ownerCount", { count: fixtureIds.length });
    return { fixtureIds, label };
  })();

  const scene = single?.kind === "scene" ? single : null;
  const convertible = effects.length > 0 && !locked;
  // 选中的外观片段都是同一个特效生成的：显示“特效参数”，改参数即重新生成
  const fx = looks.length === looks.filter((c) => c.fx).length ? commonFx(looks) : null;
  const lookIds = looks.map((c) => c.id);
  const firstStatic = statics[0]?.kind === "static" ? statics[0] : null;
  const gamma = project.output.gamma;

  return (
    <div className="flex flex-col">
      {/* 摘要与操作：始终在顶部 */}
      <header className="sticky top-0 z-10 flex flex-col gap-1 border-b border-border bg-surface-2 px-3 py-2">
        <h3 className="text-sm font-medium">
          {single
            ? (ownerTrack ? trackName(project, ownerTrack) : "") || t("editor.timeline.missingTarget")
            : t("editor.cue.selectedCount", { count: selected.length })}
        </h3>
        {owner.fixtureIds.length > 0 && (
          <p className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="min-w-0 truncate">{owner.label}</span>
            <span aria-hidden>·</span>
            <button
              type="button"
              className="inline-flex shrink-0 items-center gap-1 rounded-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => revealInPatch(owner.fixtureIds)}
            >
              <Crosshair aria-hidden className="size-3" />
              {t("editor.cue.revealInPatch")}
            </button>
          </p>
        )}
        {single && (single.kind === "look" || single.kind === "scene") && !locked && (
          // 片段名称：时间线上显示（模板 / 属性特效放下时自动填入）
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="shrink-0">{t("editor.cue.name")}</span>
            <CommitInput
              className="h-7 min-w-0 flex-1 px-2 text-xs"
              label={t("editor.cue.name")}
              value={single.label ?? ""}
              placeholder={clipName(single, project.presets, (e) => t(`editor.effects.${e}`)) || t("editor.cue.namePlaceholder")}
              onCommit={(text) => update((d) => void setCueLabel(d, single.id, text))}
            />
          </label>
        )}
        {locked && <p className="text-xs text-warning">{t("editor.cue.locked")}</p>}
        {looks.length > 0 && <LookKeyNav cues={looks} />}
        {((statics.length > 0 && !locked) || convertible || single?.kind === "look") && (
          <div role="toolbar" aria-label={t("editor.cue.actions")} className="flex flex-wrap items-center gap-1">
            {single?.kind === "look" && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                title={t("editor.effectEditor.fromClipHint")}
                onClick={() => {
                  const track = project.tracks.find((tr) => tr.id === single.trackId);
                  const lib = useEffectLibraryStore.getState();
                  const def = effectFromClip(single, {
                    members: track ? trackFixtureIds(project, track).length : 1,
                    tempo: project.tempo,
                    existing: allEffects(lib),
                    name: clipName(single, project.presets, (e) => t(`editor.effects.${e}`)) || t("editor.effectEditor.untitled"),
                  });
                  useEffectEditorStore.getState().open(def, "new");
                }}
              >
                <Sparkles aria-hidden />
                {t("editor.effectEditor.fromClip")}
              </Button>
            )}
            {statics.length > 0 && !locked && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
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
            {convertible && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                title={t("editor.attrEffects.convertHint")}
                onClick={() => {
                  let n = 0;
                  update((d) => {
                    n = convertLegacyEffects(d, effectIds, (def) => effectName(def, i18n.language));
                  });
                  announce(t("editor.attrEffects.converted", { count: n }));
                }}
              >
                <Layers aria-hidden />
                {t("editor.attrEffects.convert")}
              </Button>
            )}
          </div>
        )}
      </header>

      {/* 片段特有的分区（按类型），之后是所有类型共用的“亮度与淡入淡出”“时间” */}
      {firstStatic && (
        <InspectorSection
          scope="cue"
          id="color"
          title={t("editor.cue.color")}
          aside={<span aria-hidden className="size-3.5 rounded-sm border border-border" style={{ backgroundColor: cssColor(firstStatic.rgb) }} />}
        >
          {common(statics, (c) => (c.kind === "static" ? c.rgb : null)).mixed && (
            <p className="mb-1 text-xs text-muted-foreground">{t("editor.cue.mixed")}</p>
          )}
          {/* 静态片段只存 RGB：同一套色盘（色纸、我的色板、HSI、高级），不提供色温 / 发光体与白光策略 */}
          <ColorPicker
            key={ids.join(",")}
            value={{ kind: "rgb", rgb: firstStatic.rgb }}
            gamma={gamma}
            modes={RGB_ONLY}
            whiteStrategy={false}
            onCommit={(color) => patch({ rgb: color.kind === "rgb" ? [...color.rgb] : colorValueRgb(color, gamma) })}
          />
        </InspectorSection>
      )}

      {effects.length > 0 && (
        <EffectInspector
          cues={effects}
          tempo={project.tempo}
          onPatch={(changes: EffectPatch) => update((d) => void updateEffectCues(d, effectIds, changes))}
        />
      )}

      {fx && !locked && (
        <InspectorSection
          scope="cue"
          id="fx"
          title={t("editor.fx.title")}
          aside={<span className="truncate text-[11px] text-muted-foreground">{effectName(fx.def, i18n.language)}</span>}
        >
          <EffectParamsPanel
            key={lookIds.join(",")}
            def={fx.def}
            params={fx.params}
            onChange={(p) => update((d) => void setFxParams(d, lookIds, p))}
            onReset={() => update((d) => void setFxParams(d, lookIds, "reset"))}
            onDetach={() => {
              let n = 0;
              update((d) => {
                n = detachFx(d, lookIds);
              });
              announce(t("editor.fx.detachedCount", { count: n }));
            }}
          />
          <p className="mt-1.5 text-[11px] text-muted-foreground">{t("editor.fx.hint")}</p>
        </InspectorSection>
      )}

      {looks.length > 0 && <LookInspector cues={looks} />}

      {scene && (
        <InspectorSection scope="cue" id="scene" title={t("editor.scene.title")} aside={<span className="num">{scene.entries.length}</span>}>
          <SceneInspector cue={scene} />
        </InspectorSection>
      )}

      <InspectorSection scope="cue" id="fades" title={t("editor.cue.sections.fades")}>
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
      </InspectorSection>

      {(single || !locked) && (
        <InspectorSection scope="cue" id="time" title={t("editor.cue.time")}>
          {single ? (
            <TimeSection cue={single} onSetTimes={(start, end) => update((d) => void setCueTimes(d, single.id, start, end))} />
          ) : (
            <label className="flex items-center justify-between gap-2 text-sm">
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
        </InspectorSection>
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
    // 外层的分区（“时间”）提供标题
    <div className="grid grid-cols-3 gap-2">
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
    </div>
  );
}

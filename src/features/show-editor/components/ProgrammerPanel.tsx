import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Clapperboard, Crosshair, Eraser, ListPlus, Redo2, RefreshCw, Undo2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Segmented } from "@/shared/components/Segmented";
import { announce } from "@/shared/stores/announcerStore";
import { toggleLocate } from "../hooks/transportActions";
import { paramHead } from "../lib/looks";
import { colorModes } from "../lib/fixtureProfile";
import { baseOf, parseRef, pixelRefsOf } from "../lib/fixtureRef";
import { ordered } from "../lib/fixtureSelection";
import { trackFixtureIds } from "../lib/ops";
import type { ColorValue } from "../lib/project";
import {
  hasProgrammerValues,
  knockout,
  programColor,
  programIntensity,
  programIntensityBy,
  recordLengthMs,
  recordLooks,
  recordScene,
  updateCuesFromProgrammer,
  type UpdateMode,
} from "../lib/programmer";
import { useEditorPrefsStore } from "../stores/useEditorPrefsStore";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { usePlaybackStore } from "../stores/usePlaybackStore";
import { useProgrammerStore } from "../stores/useProgrammerStore";
import { useProjectStore } from "../stores/useProjectStore";
import { ColorPicker } from "./ColorPicker";
import { CommitInput } from "./CommitInput";
import { EmptyHint } from "./EmptyHint";
import { FanPanel } from "./FanPanel";
import { HelpTip } from "./HelpTip";
import { InspectorSection } from "./InspectorSection";
import { ProgrammerAttrs } from "./ProgrammerAttrs";
import { SelectionTools } from "./SelectionTools";
import { SliderField } from "./SliderField";

/** 强度快捷按钮的步长（百分点）。 */
const INTENSITY_STEP = 10;

/**
 * 编程器面板（同一帧给多台灯具设值）：
 *
 * 1. 用选择工具选灯（奇偶、隔 N、分组…，也可以在预览区点选）；
 * 2. 给选中的灯设强度、颜色、属性，或按选择顺序分布——编程器的值立刻叠在预览上（置顶层），
 *    打开“实时输出”时灯也会跟着亮；“高亮”让选中的灯临时满亮白光，方便逐台找灯；
 * 3. 换一批灯继续设，不同的灯可以是不同的值；编程器有自己的撤销（不影响工程撤销）；
 * 4. 在播放头处“记录为场景片段”或“记录到各自轨道”，也可以“更新到所选片段”。
 *
 * 顶部是摘要与全局操作（实时输出、高亮、撤销、移出所选、清空），下面是可折叠分区，展开状态记住；
 * 每个分区标题旁的“?”悬停看一句话、点开看详细说明。
 */
export function ProgrammerPanel() {
  const { t } = useTranslation();
  const project = useProjectStore((s) => s.project);
  const update = useProjectStore((s) => s.update);
  const selectedRaw = useEditorUiStore((s) => s.selectedFixtureIds);
  const selectedCueIds = useEditorUiStore((s) => s.selectedCueIds);
  const values = useProgrammerStore((s) => s.values);
  const live = useProgrammerStore((s) => s.live);
  const highlight = useProgrammerStore((s) => s.highlight);
  const canUndo = useProgrammerStore((s) => s.past.length > 0);
  const canRedo = useProgrammerStore((s) => s.future.length > 0);
  const setValues = useProgrammerStore((s) => s.setValues);
  const setLive = useProgrammerStore((s) => s.setLive);
  const setHighlight = useProgrammerStore((s) => s.setHighlight);
  const clear = useProgrammerStore((s) => s.clear);
  const undo = useProgrammerStore((s) => s.undo);
  const redo = useProgrammerStore((s) => s.redo);
  const rec = useEditorPrefsStore((s) => s.programmerRecord);
  const setRec = useEditorPrefsStore((s) => s.setProgrammerRecord);
  const locateId = usePlaybackStore((s) => s.state?.locate ?? null);

  // 可编程的引用：每台灯先整灯、再各像素（像素可以单独设强度 / 颜色并记录成场景条目）
  const { fixtures, fixtureModels } = project;
  const all = useMemo(() => fixtures.flatMap((f) => [f.id, ...pixelRefsOf({ fixtureModels }, f)]), [fixtures, fixtureModels]);
  const selected = useMemo(() => ordered(all, selectedRaw), [all, selectedRaw]);
  // 分布按点选的顺序（grandMA3 的约定）；连选时就是屏幕上的顺序
  const selectionOrder = useMemo(() => {
    const valid = new Set(all);
    return [...new Set(selectedRaw)].filter((id) => valid.has(id));
  }, [all, selectedRaw]);
  const programmed = useMemo(
    () => all.filter((id) => values[id] && hasProgrammerValues({ [id]: values[id] })),
    [all, values],
  );

  if (project.fixtures.length === 0) return <EmptyHint>{t("editor.patch.empty")}</EmptyHint>;

  // 选中灯具在编程器里的代表值（第一台有值的）与是否不一致
  const firstLook = selected.map((id) => values[id]).find((l) => l);
  const intensity = paramHead(firstLook?.intensity) ?? 0;
  const color: ColorValue | undefined = paramHead(firstLook?.color);
  const first = selected[0] ? parseRef(selected[0]) : null;
  const firstFixture = first ? project.fixtures.find((f) => f.id === first.fixtureId) : undefined;
  const firstModel = firstFixture ? project.fixtureModels.find((m) => m.id === firstFixture.modelId) : undefined;
  const target = firstModel ? { model: firstModel, modeId: firstFixture?.modeId, head: first?.head } : null;
  const mixedIntensity = new Set(selected.map((id) => paramHead(values[id]?.intensity) ?? null)).size > 1;
  const disabled = selected.length === 0;
  // Locate 作用于整台灯：只选了一台（或它的像素）时可用
  const locateTarget = new Set(selected.map(baseOf)).size === 1 ? baseOf(selected[0]) : null;
  const lengthMs = recordLengthMs(rec, project.tempo);
  const beatsAvailable = project.tempo !== null;

  const setColor = (value: ColorValue) => {
    let next = programColor(values, selected, value);
    // 只有颜色没有强度不会发光：还没设过强度的灯自动给 100%
    const dark = selected.filter((id) => !next[id]?.intensity);
    if (dark.length > 0) next = programIntensity(next, dark, 100);
    setValues(next);
  };

  const record = (mode: "scene" | "looks") => {
    const at = useEditorUiStore.getState().playheadMs;
    let created = 0;
    let skipped = 0;
    update((d) => {
      const opts = { fadeInMs: rec.fadeInMs };
      const r =
        mode === "scene"
          ? recordScene(d, values, at, lengthMs, t("editor.programmer.sceneTrack"), opts)
          : recordLooks(d, values, at, lengthMs, opts);
      created = r.cueIds.length;
      skipped = r.skipped.length;
    });
    announce(
      created === 0
        ? t("editor.programmer.noRoom")
        : t(mode === "scene" ? "editor.programmer.recordedScene" : "editor.programmer.recordedLooks", {
            count: created,
            skipped,
          }),
    );
  };

  const updateCues = (mode: UpdateMode) => {
    let n = 0;
    update((d) => {
      n = updateCuesFromProgrammer(d, values, selectedCueIds, mode, (track) => trackFixtureIds(d, track));
    });
    announce(n > 0 ? t("editor.programmer.updated", { count: n }) : t("editor.programmer.nothingUpdated"));
  };

  const ghost = (label: string, onClick: () => void, opts: { disabled?: boolean; icon?: ReactNode; pressed?: boolean } = {}) => (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 px-2 text-xs"
      disabled={opts.disabled}
      aria-pressed={opts.pressed}
      onClick={onClick}
    >
      {opts.icon}
      {label}
    </Button>
  );
  const iconButton = (label: string, onClick: () => void, icon: ReactNode, enabled: boolean) => (
    <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={label} title={label} disabled={!enabled} onClick={onClick}>
      {icon}
    </Button>
  );

  return (
    <div className="flex flex-col">
      {/* 摘要与全局操作：始终在顶部（实时输出、高亮、清空是全局状态，一直能看到） */}
      <div className="sticky top-0 z-10 flex flex-col gap-1.5 border-b border-border bg-surface-2 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 truncate text-sm font-medium">
            <span role="status" className="num">
              {t("editor.select.count", { count: selected.length, total: project.fixtures.length })}
            </span>
            <span aria-hidden className="mx-1.5 text-xs font-normal text-muted-foreground">
              ·
            </span>
            <span className="num text-xs font-normal text-muted-foreground">{t("editor.programmer.programmed", { count: programmed.length })}</span>
          </p>
          <HelpTip topic="editor.help.programmer.overview" />
        </div>
        <div data-tour="programmer-tools" className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <label className="flex shrink-0 items-center gap-1.5 text-xs">
            {t("editor.programmer.live")}
            <Switch aria-label={t("editor.programmer.live")} checked={live} onCheckedChange={setLive} />
          </label>
          <label className="flex shrink-0 items-center gap-1.5 text-xs">
            {t("editor.programmer.highlight")}
            <Switch aria-label={t("editor.programmer.highlight")} checked={highlight} onCheckedChange={setHighlight} />
          </label>
          <HelpTip topic="editor.help.programmer.highlight" className="-ml-2" />
          <span className="ml-auto flex items-center">
            {iconButton(t("editor.programmer.undo"), undo, <Undo2 aria-hidden />, canUndo)}
            {iconButton(t("editor.programmer.redo"), redo, <Redo2 aria-hidden />, canRedo)}
          </span>
        </div>
        {highlight && !live && <p className="text-[11px] text-muted-foreground">{t("editor.programmer.highlightPreviewOnly")}</p>}
        {disabled && <p className="text-xs text-muted-foreground">{t("editor.programmer.selectFirst")}</p>}
        <div role="toolbar" aria-label={t("editor.programmer.actions")} className="flex flex-wrap items-center gap-1">
          {ghost(t("editor.programmer.knockSelected"), () => setValues(knockout(values, selected)), { disabled })}
          {ghost(
            t("editor.programmer.clear"),
            () => {
              clear();
              announce(t("editor.programmer.cleared"));
            },
            { disabled: programmed.length === 0 && !live && !highlight, icon: <Eraser aria-hidden /> },
          )}
        </div>
      </div>

      <InspectorSection scope="program" id="select" title={t("editor.select.title")} help="editor.help.programmer.select">
        <SelectionTools />
      </InspectorSection>

      {!disabled && (
        <>
          <InspectorSection scope="program" id="intensity" title={t("editor.programmer.intensity")} help="editor.help.programmer.intensity">
            <SliderField
              label={t("editor.programmer.intensity")}
              numberLabel={t("editor.programmer.intensityValue")}
              value={intensity}
              min={0}
              max={100}
              unit="%"
              mixed={mixedIntensity}
              mixedLabel={t("editor.cue.mixed")}
              onCommit={(v) => setValues(programIntensity(values, selected, v))}
            />
            <div role="group" aria-label={t("editor.programmer.quickIntensity")} className="flex flex-wrap items-center gap-1">
              {ghost(t("editor.programmer.full"), () => setValues(programIntensity(values, selected, 100)))}
              {ghost(t("editor.programmer.zero"), () => setValues(programIntensity(values, selected, 0)))}
              {ghost(`+${INTENSITY_STEP}%`, () => setValues(programIntensityBy(values, selected, INTENSITY_STEP)))}
              {ghost(`−${INTENSITY_STEP}%`, () => setValues(programIntensityBy(values, selected, -INTENSITY_STEP)))}
              {locateTarget &&
                ghost(t("editor.programmer.locate"), () => void toggleLocate(locateTarget), {
                  icon: <Crosshair aria-hidden />,
                  pressed: locateId === locateTarget,
                })}
            </div>
            <div>{ghost(t("editor.programmer.knockIntensity"), () => setValues(knockout(values, selected, "intensity")))}</div>
          </InspectorSection>
          <InspectorSection scope="program" id="color" title={t("editor.programmer.color")} help="editor.help.programmer.color">
            <ColorPicker
              key={selected.join(",")}
              value={color}
              target={target}
              gamma={project.output.gamma}
              modes={colorModes(project, selected)}
              onCommit={setColor}
            />
            <div>{ghost(t("editor.programmer.knockColor"), () => setValues(knockout(values, selected, "color")))}</div>
          </InspectorSection>
          <InspectorSection scope="program" id="attrs" title={t("editor.programmer.attrs")} help="editor.help.programmer.attrs">
            <ProgrammerAttrs project={project} selected={selected} values={values} onChange={setValues} />
          </InspectorSection>
          <InspectorSection scope="program" id="fan" title={t("editor.fan.title")} help="editor.help.programmer.fan">
            <FanPanel project={project} order={selectionOrder} values={values} onChange={setValues} />
          </InspectorSection>
        </>
      )}

      <InspectorSection scope="program" id="record" title={t("editor.programmer.record")} help="editor.help.programmer.record">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{t("editor.programmer.length")}</span>
          {rec.unit === "beats" && beatsAvailable ? (
            <CommitInput
              className="num h-7 w-16 px-2 text-xs"
              inputMode="numeric"
              label={t("editor.programmer.lengthBeats")}
              value={rec.beats}
              onCommit={(text) => {
                const n = Number(text);
                if (Number.isFinite(n) && n > 0) setRec({ beats: n });
              }}
            />
          ) : (
            <CommitInput
              className="num h-7 w-20 px-2 text-xs"
              inputMode="numeric"
              label={t("editor.programmer.length")}
              value={rec.lengthMs}
              onCommit={(text) => {
                const n = Math.round(Number(text));
                if (Number.isFinite(n) && n >= 100 && n <= 3_600_000) setRec({ lengthMs: n });
              }}
            />
          )}
          <Segmented<"ms" | "beats">
            size="xs"
            ariaLabel={t("editor.programmer.lengthUnit")}
            value={rec.unit === "beats" && beatsAvailable ? "beats" : "ms"}
            options={[
              { value: "ms", label: "ms" },
              { value: "beats", label: t("editor.programmer.beats"), disabled: !beatsAvailable, title: beatsAvailable ? undefined : t("editor.programmer.noTempo") },
            ]}
            onChange={(unit) => setRec({ unit })}
          />
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          {t("editor.programmer.fadeIn")}
          <CommitInput
            className="num h-7 w-20 px-2 text-xs"
            inputMode="numeric"
            label={t("editor.programmer.fadeIn")}
            value={rec.fadeInMs}
            onCommit={(text) => {
              const n = Math.round(Number(text));
              if (Number.isFinite(n) && n >= 0) setRec({ fadeInMs: n });
            }}
          />
          ms
        </label>
        <div className="flex flex-wrap gap-1.5">
          <Button type="button" size="sm" className="h-8" disabled={programmed.length === 0} onClick={() => record("scene")}>
            <Clapperboard aria-hidden />
            {t("editor.programmer.recordScene")}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-8"
            disabled={programmed.length === 0}
            onClick={() => record("looks")}
          >
            <ListPlus aria-hidden />
            {t("editor.programmer.recordLooks")}
          </Button>
        </div>
        <div role="group" aria-label={t("editor.programmer.updateGroup")} className="flex flex-wrap items-center gap-1">
          {ghost(t("editor.programmer.updateMerge", { count: selectedCueIds.length }), () => updateCues("merge"), {
            disabled: programmed.length === 0 || selectedCueIds.length === 0,
            icon: <RefreshCw aria-hidden />,
          })}
          {ghost(t("editor.programmer.updateReplace"), () => updateCues("replace"), {
            disabled: programmed.length === 0 || selectedCueIds.length === 0,
          })}
        </div>
        <p className="text-xs text-muted-foreground">{t("editor.programmer.recordHint")}</p>
      </InspectorSection>
    </div>
  );
}

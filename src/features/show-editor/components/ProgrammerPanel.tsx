import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Clapperboard, Eraser, ListPlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { announce } from "@/shared/stores/announcerStore";
import { paramHead } from "../lib/looks";
import { ordered } from "../lib/fixtureSelection";
import type { ColorValue } from "../lib/project";
import {
  hasProgrammerValues,
  knockout,
  programColor,
  programIntensity,
  recordLooks,
  recordScene,
} from "../lib/programmer";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProgrammerStore } from "../stores/useProgrammerStore";
import { useProjectStore } from "../stores/useProjectStore";
import { ColorPicker } from "./ColorPicker";
import { CommitInput } from "./CommitInput";
import { EmptyHint } from "./EmptyHint";
import { SelectionTools } from "./SelectionTools";
import { SliderField } from "./SliderField";

/** 记录片段的默认长度（毫秒）。 */
const DEFAULT_RECORD_MS = 2000;

/**
 * 编程器面板（同一帧给多台灯具设值）：
 *
 * 1. 用选择工具选灯（奇偶、隔 N、分组…，也可以在预览区点选）；
 * 2. 给选中的灯设强度、颜色——编程器的值立刻叠在预览上（置顶层），打开“实时输出”时灯也会跟着亮；
 * 3. 换一批灯继续设，不同的灯可以是不同的值；
 * 4. 在播放头处“记录为场景片段”（一个片段里多台灯各自的外观），或“记录到各自轨道”。
 */
export function ProgrammerPanel() {
  const { t } = useTranslation();
  const project = useProjectStore((s) => s.project);
  const update = useProjectStore((s) => s.update);
  const selectedRaw = useEditorUiStore((s) => s.selectedFixtureIds);
  const values = useProgrammerStore((s) => s.values);
  const live = useProgrammerStore((s) => s.live);
  const setValues = useProgrammerStore((s) => s.setValues);
  const setLive = useProgrammerStore((s) => s.setLive);
  const clear = useProgrammerStore((s) => s.clear);
  const [lengthMs, setLengthMs] = useState(DEFAULT_RECORD_MS);

  const all = useMemo(() => project.fixtures.map((f) => f.id), [project.fixtures]);
  const selected = useMemo(() => ordered(all, selectedRaw), [all, selectedRaw]);
  const programmed = useMemo(
    () => all.filter((id) => values[id] && hasProgrammerValues({ [id]: values[id] })),
    [all, values],
  );

  if (project.fixtures.length === 0) return <EmptyHint>{t("editor.patch.empty")}</EmptyHint>;

  // 选中灯具在编程器里的代表值（第一台有值的）与是否不一致
  const firstLook = selected.map((id) => values[id]).find((l) => l);
  const intensity = paramHead(firstLook?.intensity) ?? 0;
  const color: ColorValue | undefined = paramHead(firstLook?.color);
  const firstFixture = project.fixtures.find((f) => f.id === selected[0]);
  const firstModel = firstFixture ? project.fixtureModels.find((m) => m.id === firstFixture.modelId) : undefined;
  const target = firstModel ? { model: firstModel, modeId: firstFixture?.modeId } : null;
  const mixedIntensity = new Set(selected.map((id) => paramHead(values[id]?.intensity) ?? null)).size > 1;
  const disabled = selected.length === 0;

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
      const r =
        mode === "scene"
          ? recordScene(d, values, at, lengthMs, t("editor.programmer.sceneTrack"))
          : recordLooks(d, values, at, lengthMs);
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

  return (
    <div className="flex flex-col gap-4 p-3">
      <SelectionTools />

      <section aria-label={t("editor.programmer.values")} className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {t("editor.programmer.values")}
          </h3>
          <span className="num text-xs text-muted-foreground">
            {t("editor.programmer.programmed", { count: programmed.length })}
          </span>
        </div>
        {disabled ? (
          <p className="text-xs text-muted-foreground">{t("editor.programmer.selectFirst")}</p>
        ) : (
          <>
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
            <ColorPicker
              key={selected.join(",")}
              value={color}
              target={target}
              gamma={project.output.gamma}
              onCommit={setColor}
            />
            <div className="flex flex-wrap gap-1.5">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => setValues(knockout(values, selected, "intensity"))}
              >
                {t("editor.programmer.knockIntensity")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => setValues(knockout(values, selected, "color"))}
              >
                {t("editor.programmer.knockColor")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => setValues(knockout(values, selected))}
              >
                {t("editor.programmer.knockSelected")}
              </Button>
            </div>
          </>
        )}
      </section>

      <section aria-label={t("editor.programmer.record")} className="flex flex-col gap-2 border-t border-border pt-3">
        <label className="flex items-center justify-between gap-2 text-sm">
          <span>
            {t("editor.programmer.live")}
            <span className="block text-xs text-muted-foreground">{t("editor.programmer.liveHint")}</span>
          </span>
          <Switch checked={live} onCheckedChange={setLive} />
        </label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          {t("editor.programmer.length")}
          <CommitInput
            className="num h-7 w-20 px-2 text-xs"
            inputMode="numeric"
            label={t("editor.programmer.length")}
            value={lengthMs}
            onCommit={(text) => {
              const n = Math.round(Number(text));
              if (Number.isFinite(n) && n >= 100 && n <= 3_600_000) setLengthMs(n);
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
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8"
            disabled={programmed.length === 0 && !live}
            onClick={() => {
              clear();
              announce(t("editor.programmer.cleared"));
            }}
          >
            <Eraser aria-hidden />
            {t("editor.programmer.clear")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("editor.programmer.recordHint")}</p>
      </section>
    </div>
  );
}

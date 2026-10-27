import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useDraggable } from "@dnd-kit/core";
import { BookmarkPlus, Link2, Trash2, Wand2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { announce } from "@/shared/stores/announcerStore";
import { colorValueRgb, paramHead } from "../lib/looks";
import { createPreset, presetUsage, PRESET_GROUPS, removePreset, renamePreset } from "../lib/presetOps";
import type { Preset } from "../lib/project";
import { mergeLayers } from "../lib/layers";
import { hasProgrammerValues } from "../lib/programmer";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProgrammerStore } from "../stores/useProgrammerStore";
import { useProjectStore } from "../stores/useProjectStore";
import { CommitInput } from "./CommitInput";
import { EmptyHint } from "./EmptyHint";

/**
 * 预设的代表色（色块用）：有颜色层取第一个值，否则按强度给灰度。
 *
 * @param preset 预设。
 * @returns CSS 颜色。
 */
function swatchOf(preset: Preset): string {
  const color = paramHead(preset.look.color);
  if (color) {
    const [r, g, b] = colorValueRgb(color);
    return `rgb(${r} ${g} ${b})`;
  }
  const level = paramHead(preset.look.intensity);
  const v = Math.round(((level ?? 0) / 100) * 255);
  return `rgb(${v} ${v} ${v})`;
}

/** 拖拽数据：标明被拖的是预设。 */
export interface PresetDragData {
  kind: "preset";
  presetId: string;
  name: string;
  swatch: string;
}

/** 预设芯片（拖拽浮层用）。 */
export function PresetChip({ name, swatch }: { name: string; swatch: string }) {
  return (
    <span className="flex items-center gap-2 rounded-md border border-primary bg-card px-2.5 py-2 text-sm shadow-lg">
      <span
        aria-hidden
        className="size-4 shrink-0 rounded-sm border border-border bg-(--preset-color)"
        style={{ "--preset-color": swatch } as CSSProperties}
      />
      <span className="truncate">{name}</span>
    </span>
  );
}

/** 预设的色块，也是拖拽把手：拖到轨道上新建一个引用该预设的外观片段。 */
function PresetHandle({ preset }: { preset: Preset }) {
  const { t } = useTranslation();
  const swatch = swatchOf(preset);
  const data: PresetDragData = { kind: "preset", presetId: preset.id, name: preset.name, swatch };
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({ id: `preset:${preset.id}`, data });
  return (
    <button
      ref={setNodeRef}
      type="button"
      {...listeners}
      {...attributes}
      aria-label={t("editor.presets.drag", { name: preset.name })}
      title={t("editor.presets.drag", { name: preset.name })}
      className={cn(
        "size-6 shrink-0 cursor-grab rounded-sm border border-border bg-(--preset-color) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isDragging && "opacity-40",
      )}
      style={{ "--preset-color": swatch } as CSSProperties}
    />
  );
}

/**
 * 素材库的“预设”分区：可被片段引用的外观，修改预设后引用它的片段一起变化。
 *
 * - 从所选外观片段新建预设（自动按出现的层归类）；
 * - 把预设应用到所选外观片段（片段里显式写出的层仍然优先）；
 * - 重命名、删除（删除时引用它的片段把内容烘焙进自己，画面不变）。
 */
export function PresetsTab() {
  const { t } = useTranslation();
  const presets = useProjectStore((s) => s.project.presets);
  const cues = useProjectStore((s) => s.project.cues);
  const update = useProjectStore((s) => s.update);
  const selectedCueIds = useEditorUiStore((s) => s.selectedCueIds);
  const selectedFixtureIds = useEditorUiStore((s) => s.selectedFixtureIds);
  const programmerValues = useProgrammerStore((s) => s.values);
  const setProgrammerValues = useProgrammerStore((s) => s.setValues);
  const [filter, setFilter] = useState<Preset["group"]>("all");

  const selectedLooks = cues.filter((c) => c.kind === "look" && selectedCueIds.includes(c.id));
  const shown = filter === "all" ? presets : presets.filter((p) => p.group === filter);

  const createFromSelection = () => {
    const source = selectedLooks[0];
    if (source?.kind !== "look") return;
    update((d) => void createPreset(d, "", source.look, t("editor.presets.defaultName", { n: d.presets.length + 1 })));
    announce(t("editor.presets.created"));
  };

  const applyToSelection = (preset: Preset) => {
    const ids = new Set(selectedLooks.map((c) => c.id));
    update((d) => {
      for (const c of d.cues) if (c.kind === "look" && ids.has(c.id)) c.look.presetId = preset.id;
    });
    announce(t("editor.presets.applied", { name: preset.name, count: ids.size }));
  };

  // 编程器里第一台（优先选中的）有值的灯具的外观
  const programmerSource = (() => {
    const ids = [...selectedFixtureIds, ...Object.keys(programmerValues)];
    const id = ids.find((x) => programmerValues[x] && hasProgrammerValues({ [x]: programmerValues[x] }));
    return id ? programmerValues[id] : undefined;
  })();

  const createFromProgrammer = () => {
    if (!programmerSource) return;
    update((d) => void createPreset(d, "", programmerSource, t("editor.presets.defaultName", { n: d.presets.length + 1 })));
    announce(t("editor.presets.created"));
  };

  const applyToProgrammer = (preset: Preset) => {
    let next = { ...programmerValues };
    for (const id of selectedFixtureIds) {
      const look = { ...(next[id] ?? {}) };
      mergeLayers(look, preset.look);
      next = { ...next, [id]: look };
    }
    setProgrammerValues(next);
    announce(t("editor.presets.appliedProgrammer", { name: preset.name, count: selectedFixtureIds.length }));
  };

  return (
    <div className="flex flex-col gap-2 p-2">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="justify-start"
        disabled={selectedLooks.length === 0}
        title={selectedLooks.length === 0 ? t("editor.presets.needLook") : undefined}
        onClick={createFromSelection}
      >
        <BookmarkPlus aria-hidden />
        {t("editor.presets.fromSelection")}
      </Button>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="justify-start"
        disabled={!programmerSource}
        title={!programmerSource ? t("editor.presets.needProgrammer") : undefined}
        onClick={createFromProgrammer}
      >
        <BookmarkPlus aria-hidden />
        {t("editor.presets.fromProgrammer")}
      </Button>
      <p className="px-1 text-[11px] text-muted-foreground">{t("editor.presets.dragHint")}</p>
      <div role="radiogroup" aria-label={t("editor.presets.filter")} className="flex flex-wrap gap-1">
        {PRESET_GROUPS.map((g) => (
          <button
            key={g}
            type="button"
            role="radio"
            aria-checked={filter === g}
            onClick={() => setFilter(g)}
            className={cn(
              "cursor-pointer rounded-full border px-2 py-0.5 text-[11px] transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              filter === g ? "border-primary bg-primary/15 text-primary" : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`editor.presets.group.${g}`)}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <EmptyHint>{t("editor.presets.empty")}</EmptyHint>
      ) : (
        <ul className="flex flex-col gap-1">
          {shown.map((p) => {
            const usage = presetUsage({ cues }, p.id);
            return (
              <li key={p.id} className="flex items-center gap-2 rounded-md border border-border bg-card p-1.5">
                <PresetHandle preset={p} />
                <div className="min-w-0 flex-1">
                  <CommitInput
                    className="h-7 px-2 text-sm"
                    label={t("editor.presets.nameOf", { name: p.name })}
                    value={p.name}
                    onCommit={(name) => update((d) => renamePreset(d, p.id, name))}
                  />
                  <p className="mt-0.5 px-2 text-[11px] text-muted-foreground">
                    {t(`editor.presets.group.${p.group}`)} · {t("editor.presets.usage", { count: usage })}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0"
                  disabled={selectedLooks.length === 0}
                  aria-label={t("editor.presets.apply", { name: p.name })}
                  title={t("editor.presets.apply", { name: p.name })}
                  onClick={() => applyToSelection(p)}
                >
                  <Link2 aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0"
                  disabled={selectedFixtureIds.length === 0}
                  aria-label={t("editor.presets.applyProgrammer", { name: p.name })}
                  title={t("editor.presets.applyProgrammer", { name: p.name })}
                  onClick={() => applyToProgrammer(p)}
                >
                  <Wand2 aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0"
                  aria-label={t("editor.presets.delete", { name: p.name })}
                  title={t("editor.presets.delete", { name: p.name })}
                  onClick={() => {
                    let baked = 0;
                    update((d) => {
                      baked = removePreset(d, p.id);
                    });
                    announce(t("editor.presets.deleted", { name: p.name, count: baked }));
                  }}
                >
                  <Trash2 aria-hidden />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

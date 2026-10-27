import { useMemo, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { announce } from "@/shared/stores/announcerStore";
import { applyDraft, DEFAULT_DRAFT, DRAFT_PALETTES, moverIds, planDraft, type DraftOptions, type DraftPalette } from "../lib/autoDraft";
import { formatTimecode } from "../lib/time";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";
import { BeatAnalysisPanel } from "./BeatAnalysisPanel";
import { SliderField } from "./SliderField";

const PALETTES = Object.keys(DRAFT_PALETTES) as DraftPalette[];

/**
 * 一键生成灯光草稿：选配色、亮度上限、摇头灯是否加动作，预览每个段落的编排后一键生成（一步撤销）。
 *
 * 需要节拍（没有时在对话框里直接从音乐分析）；有段落时按段落编排，否则按 8 小节切分。
 */
export function AutoDraftDialog() {
  const { t } = useTranslation();
  const open = useEditorUiStore((s) => s.draftOpen);
  const setOpen = useEditorUiStore((s) => s.setDraftOpen);
  const project = useProjectStore((s) => s.project);
  const update = useProjectStore((s) => s.update);
  const [options, setOptions] = useState<DraftOptions>(DEFAULT_DRAFT);
  const plan = useMemo(() => planDraft(project, options), [project, options]);
  const movers = useMemo(() => moverIds(project).length, [project]);
  const noFixtures = project.fixtures.length === 0;

  const generate = () => {
    let created = 0;
    update((d) => {
      created = applyDraft(d, plan, options, { all: t("editor.draft.groupAll"), movers: t("editor.draft.groupMovers") }).cueIds.length;
    });
    announce(t("editor.draft.done", { count: created }));
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex max-h-[88vh] max-w-xl flex-col gap-4 overflow-hidden p-6">
        <DialogHeader>
          <DialogTitle>{t("editor.draft.title")}</DialogTitle>
          <DialogDescription>{t("editor.draft.description")}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 overflow-auto">
          {!project.tempo && (
            <div className="grid gap-2 rounded-md border border-border p-3">
              <p className="text-sm">{t("editor.draft.needTempo")}</p>
              <BeatAnalysisPanel />
            </div>
          )}

          <div role="radiogroup" aria-label={t("editor.draft.palette")} className="grid gap-2">
            <span className="text-sm">{t("editor.draft.palette")}</span>
            <div className="flex flex-wrap gap-2">
              {PALETTES.map((p) => (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={options.palette === p}
                  onClick={() => setOptions({ ...options, palette: p })}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    options.palette === p ? "border-primary bg-primary/10" : "border-border hover:bg-accent",
                  )}
                >
                  <span aria-hidden className="flex">
                    {DRAFT_PALETTES[p].map(([r, g, b], i) => (
                      <span
                        key={i}
                        className="-ml-1 size-3.5 rounded-full border border-background bg-(--swatch) first:ml-0"
                        style={{ "--swatch": `rgb(${r} ${g} ${b})` } as CSSProperties}
                      />
                    ))}
                  </span>
                  {t(`editor.draft.palettes.${p}`)}
                </button>
              ))}
            </div>
          </div>

          <SliderField
            label={t("editor.draft.intensity")}
            numberLabel={t("editor.draft.intensityValue")}
            value={options.intensity}
            min={10}
            max={100}
            unit="%"
            onCommit={(v) => setOptions({ ...options, intensity: v })}
          />

          <label className="flex items-center justify-between gap-2 text-sm">
            <span>
              {t("editor.draft.movement")}
              <span className="block text-xs text-muted-foreground">{t("editor.draft.movementHint", { count: movers })}</span>
            </span>
            <Switch
              aria-label={t("editor.draft.movement")}
              checked={options.movement}
              disabled={movers < 2}
              onCheckedChange={(movement) => setOptions({ ...options, movement })}
            />
          </label>

          {plan.length > 0 && (
            <ol aria-label={t("editor.draft.preview")} className="grid gap-1 text-xs">
              {plan.map((item) => {
                const [r, g, b] = item.color;
                return (
                  <li key={item.startMs} className="flex items-center gap-2 rounded border border-border px-2 py-1">
                    <span
                      aria-hidden
                      className="size-3 shrink-0 rounded-sm bg-(--swatch)"
                      style={{ "--swatch": `rgb(${r} ${g} ${b})` } as CSSProperties}
                    />
                    <span className="num w-28 shrink-0 text-muted-foreground">
                      {formatTimecode(item.startMs)} – {formatTimecode(item.endMs)}
                    </span>
                    <span className="w-12 shrink-0">{t(`editor.beats.tier.${item.tier}`)}</span>
                    <span className="min-w-0 flex-1 truncate">
                      {t(`editor.draft.lights.${item.light}`)}
                      {item.move !== "none" && options.movement && movers >= 2 && ` · ${t(`editor.draft.moves.${item.move}`)}`}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
          <p className="text-xs text-muted-foreground">
            {project.sections.length > 0 ? t("editor.draft.bySections", { count: project.sections.length }) : t("editor.draft.byBars")}
          </p>
        </div>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            {t("editor.draft.cancel")}
          </Button>
          <Button type="button" disabled={plan.length === 0 || noFixtures} onClick={generate}>
            {noFixtures ? t("editor.draft.noFixtures") : t("editor.draft.generate", { count: plan.length })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

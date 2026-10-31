import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { AudioWaveform, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useActiveAiProfile } from "@/features/ai";
import { cn } from "@/lib/utils";
import { Segmented } from "@/shared/components/Segmented";
import { announce } from "@/shared/stores/announcerStore";
import { colorRgb, NAMED_COLORS, PALETTE_NAMES, PALETTES as AI_PALETTES, type PaletteName } from "../ai/vocab";
import { useAiDraft } from "../hooks/useAiDraft";
import { applyDraft, DEFAULT_DRAFT, DRAFT_PALETTES, moverIds, planDraft, type DraftOptions, type DraftPalette } from "../lib/autoDraft";
import { primaryMedia } from "../lib/media";
import { formatTimecode } from "../lib/time";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useMediaAnalysisStore, useTimelineAnalysis } from "../stores/useMediaAnalysisStore";
import { useProjectStore } from "../stores/useProjectStore";
import { BeatAnalysisPanel } from "./BeatAnalysisPanel";
import { SliderField } from "./SliderField";

const PALETTES = Object.keys(DRAFT_PALETTES) as DraftPalette[];

/**
 * 一键生成灯光草稿，两种方式：
 *
 * - AI 生成：写一句描述（风格、情绪、颜色），模型按段落给出每段的能量、灯光与动作，结果进入暂存区审阅
 *   （开了“自动写入”时直接写入）；
 * - 按规则生成：选配色、亮度上限、摇头灯是否加动作，预览每个段落的编排后一键生成（一步撤销），不需要 AI。
 *
 * 有段落时按段落编排，否则按 8 小节切分。规则生成需要节拍（没有时在对话框里直接从音乐分析）。
 */
export function AutoDraftDialog() {
  const { t } = useTranslation();
  const open = useEditorUiStore((s) => s.draftOpen);
  const setOpen = useEditorUiStore((s) => s.setDraftOpen);
  const hasProfiles = useActiveAiProfile().profiles.length > 0;
  const [mode, setMode] = useState<"ai" | "rules" | null>(null);
  // 有 AI 配置时默认用 AI；用户切换过就记住本次的选择
  const current = mode ?? (hasProfiles ? "ai" : "rules");
  const switcher = (
    <Segmented
      ariaLabel={t("editor.draft.mode")}
      value={current}
      onChange={setMode}
      size="sm"
      options={[
        { value: "ai", label: t("editor.draft.modeAi") },
        { value: "rules", label: t("editor.draft.modeRules") },
      ]}
    />
  );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex max-h-[88vh] max-w-xl flex-col gap-4 overflow-hidden p-6">
        <DialogHeader>
          <DialogTitle>{t("editor.draft.title")}</DialogTitle>
          <DialogDescription>{t(current === "ai" ? "editor.draft.descriptionAi" : "editor.draft.description")}</DialogDescription>
        </DialogHeader>
        {switcher}
        {current === "ai" ? <AiDraftForm onDone={() => setOpen(false)} /> : <RuleDraftForm onDone={() => setOpen(false)} />}
      </DialogContent>
    </Dialog>
  );
}

/** AI 调色板的显示色。 */
const paletteRgb = (p: PaletteName) => AI_PALETTES[p].map((c) => colorRgb(NAMED_COLORS[c]));

/** 用 AI 生成：描述 + 可选调色板；结果进入暂存区审阅。 */
function AiDraftForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const project = useProjectStore((s) => s.project);
  const [prompt, setPrompt] = useState("");
  const [palette, setPalette] = useState<PaletteName | null>(null);
  const [accents, setAccents] = useState(true);
  const draft = useAiDraft();
  const noFixtures = project.fixtures.length === 0;
  const music = useMusicStatus();
  const hasEvents = !!music.analysis && music.analysis.events.some((e) => e.kind !== "cut");

  const generate = async () => {
    if (await draft.generate(prompt, palette, accents && hasEvents)) onDone();
  };

  if (!draft.hasProfiles) {
    return (
      <div className="grid gap-3 text-sm">
        <p className="text-muted-foreground">{t("ai.errors.no_profile")}</p>
        <Button variant="outline" onClick={() => navigate("/settings#ai")}>
          {t("editor.ai.openSettings")}
        </Button>
      </div>
    );
  }

  return (
    <>
      <div className="grid gap-4 overflow-auto">
        <div className="grid gap-1.5">
          <Label htmlFor="ai-draft-prompt">{t("editor.draft.prompt")}</Label>
          <Textarea
            id="ai-draft-prompt"
            value={prompt}
            maxLength={400}
            placeholder={t("editor.draft.promptPlaceholder")}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </div>
        <div role="radiogroup" aria-label={t("editor.draft.palette")} className="grid gap-2">
          <span className="text-sm">{t("editor.draft.palette")}</span>
          <div className="flex flex-wrap gap-2">
            {[null, ...PALETTE_NAMES].map((p) => (
              <button
                key={p ?? "auto"}
                type="button"
                role="radio"
                aria-checked={palette === p}
                onClick={() => setPalette(p)}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  palette === p ? "border-primary bg-primary/10" : "border-border hover:bg-accent",
                )}
              >
                {p && (
                  <span aria-hidden className="flex">
                    {paletteRgb(p).map(([r, g, b], i) => (
                      <span
                        key={i}
                        className="-ml-1 size-3.5 rounded-full border border-background bg-(--swatch) first:ml-0"
                        style={{ "--swatch": `rgb(${r} ${g} ${b})` } as CSSProperties}
                      />
                    ))}
                  </span>
                )}
                {t(`editor.draft.aiPalettes.${p ?? "auto"}`)}
              </button>
            ))}
          </div>
        </div>
        <MusicStatusLine status={music} />
        {hasEvents && (
          <label data-tour="draft-accents" className="flex items-center justify-between gap-4 rounded-md border border-border px-3 py-2">
            <span className="min-w-0">
              <span className="block text-sm">{t("editor.draft.accents")}</span>
              <span className="block text-xs text-muted-foreground">{t("editor.draft.accentsHint")}</span>
            </span>
            <Switch aria-label={t("editor.draft.accents")} checked={accents} onCheckedChange={setAccents} />
          </label>
        )}
        <p className="text-xs text-muted-foreground">
          {draft.profile ? t("editor.draft.usingModel", { name: draft.profile.name }) : null}{" "}
          {project.sections.length > 0
            ? t("editor.draft.bySections", { count: project.sections.length })
            : music.analysis && music.analysis.sections.length > 0
              ? t("editor.draft.byAnalysis", { count: music.analysis.sections.length })
              : t("editor.draft.byBars")}
        </p>
        {draft.pending && (
          <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
            {draft.attempt > 1 ? t("editor.draft.fixing", { attempt: draft.attempt }) : t("editor.draft.thinking")}
          </p>
        )}
        {draft.error && (
          <p role="alert" className="text-xs text-destructive">
            {draft.error}
          </p>
        )}
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={draft.pending ? draft.cancel : onDone}>
          {draft.pending ? t("editor.ai.stop") : t("editor.draft.cancel")}
        </Button>
        <Button type="button" disabled={noFixtures} loading={draft.pending} onClick={() => void generate()}>
          {noFixtures ? t("editor.draft.noFixtures") : t("editor.draft.generateAi")}
        </Button>
      </div>
    </>
  );
}

/** 主素材的分析状态（打开对话框时只读缓存；没分析过的在点“生成”时再分析）。 */
function useMusicStatus() {
  const media = useProjectStore((s) => primaryMedia(s.project));
  const entry = useMediaAnalysisStore((s) => (media ? s.entries[media.id] : undefined));
  const analysis = useTimelineAnalysis();
  useEffect(() => {
    if (media) void useMediaAnalysisStore.getState().peek(media);
  }, [media]);
  return { media, entry, analysis };
}

/** 一行分析状态：分析中 / 结果概要 / 失败原因 / 没有音乐。 */
function MusicStatusLine({ status }: { status: ReturnType<typeof useMusicStatus> }) {
  const { t } = useTranslation();
  const { media, entry, analysis } = status;
  let text: string;
  let tone = "text-muted-foreground";
  if (!media) text = t("editor.draft.music.none");
  else if (!entry || entry.status === "none") text = t("editor.draft.music.notYet", { name: media.name });
  else if (entry.status === "loading" && !entry.audio) text = t("editor.draft.music.running", { name: media.name });
  else if (analysis && analysis.bpm > 0) {
    text = t("editor.draft.music.ready", {
      name: media.name,
      bpm: analysis.bpm,
      sections: analysis.sections.length,
      hits: analysis.events.filter((e) => e.kind === "hit").length,
      drops: analysis.events.filter((e) => e.kind === "drop").length,
    });
  } else {
    text = t("editor.draft.music.failed", { name: media.name, reason: t(`editor.draft.music.errors.${entry.error ?? "decode"}`, { defaultValue: entry.error ?? "" }) });
    tone = "text-warning";
  }
  return (
    <p role="status" aria-live="polite" className={cn("flex items-center gap-1.5 text-xs", tone)}>
      {entry?.status === "loading" || entry?.refreshing ? (
        <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
      ) : (
        <AudioWaveform className="size-3.5" aria-hidden />
      )}
      <span className="min-w-0 flex-1">{text}</span>
      {media && (!entry || entry.status === "none") && (
        <Button type="button" variant="link" size="sm" className="h-auto shrink-0 p-0 text-xs" onClick={() => void useMediaAnalysisStore.getState().ensure(media)}>
          {t("editor.draft.music.analyzeNow")}
        </Button>
      )}
    </p>
  );
}

/** 按规则生成（不需要 AI）。 */
function RuleDraftForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
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
    onDone();
  };

  return (
    <>
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
          <Button type="button" variant="ghost" onClick={onDone}>
            {t("editor.draft.cancel")}
          </Button>
          <Button type="button" disabled={plan.length === 0 || noFixtures} onClick={generate}>
            {noFixtures ? t("editor.draft.noFixtures") : t("editor.draft.generate", { count: plan.length })}
          </Button>
        </div>
    </>
  );
}

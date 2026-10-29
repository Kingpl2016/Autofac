import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Plus, TriangleAlert, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Segmented } from "@/shared/components/Segmented";
import { announce } from "@/shared/stores/announcerStore";
import { templateSwatch } from "../lib/clipVisual";
import { DEFAULT_CUE_MS } from "../lib/cueOps";
import { CUSTOM_GROUP, parseTemplates, templateKind, templateName, type CueTemplate } from "../lib/cueTemplates";
import { defaultEffectParams, EFFECT_CLIP_MS, mergeEffectParams } from "../lib/effectLibrary";
import { colorValueRgb } from "../lib/looks";
import type { ColorBlend, ColorParam, ColorValue, Easing, Look, Param } from "../lib/project";
import { upsertTemplate } from "../lib/templateOps";
import { useCueTemplateStore } from "../stores/useCueTemplateStore";
import { useProjectStore } from "../stores/useProjectStore";
import { useTemplateEditorStore } from "../stores/useTemplateEditorStore";
import { ColorPicker } from "./ColorPicker";
import { CommitInput } from "./CommitInput";
import { EffectParamsPanel } from "./EffectParamsPanel";
import { SwatchInput } from "./EffectEditorDialog";

const EASINGS: readonly Easing[] = ["linear", "easeInOut", "sCurve"];
const BLENDS: readonly ColorBlend[] = ["smooth", "step", "hue"];
/** 多色分布最多几种颜色（与工程校验一致）。 */
const MAX_SPREAD_COLORS = 16;

/**
 * 校验草稿：与读取模板文件同一套规则。
 *
 * @param draft 草稿。
 * @returns 合法时为规整后的模板，否则为问题说明。
 */
function validateTemplate(draft: CueTemplate): { ok: true; template: CueTemplate } | { ok: false; message: string } {
  const { builtin: _b, ...clean } = draft;
  void _b;
  const parsed = parseTemplates({ templates: [clean] });
  const template = parsed.templates[0];
  if (template) return { ok: true, template };
  return { ok: false, message: parsed.issues[0]?.message ?? "?" };
}

/**
 * Cue 模板编辑器：在软件里修改“我的模板”（或编辑内置模板的副本），不必手改 `cue-templates.json`。
 *
 * - 基本信息：名称（当前界面语言）、分组、种类（只读）；
 * - 颜色：RGB（含白光策略）/ 色温 / 发光体直给；颜色模板可改为沿成员铺开多种颜色（多色分布）；
 *   外观 / 特效模板的颜色只是素材库里的代表色；
 * - 特效预设模板：特效参数（插入后仍可在片段上改）；外观模板：各层概要（层在片段上编辑后再存为模板）；
 * - 高级：亮度、淡入淡出、缓动、长度（默认 / 秒 / 拍）、标签、说明。
 *
 * 保存前按模板文件的规则校验，有问题时显示原因并禁止保存。
 */
export function TemplateEditorDialog() {
  const initial = useTemplateEditorStore((s) => s.draft);
  const mode = useTemplateEditorStore((s) => s.mode);
  const close = useTemplateEditorStore((s) => s.close);
  return (
    <Dialog open={initial !== null} onOpenChange={(open) => !open && close()}>
      {initial && <EditorBody key={initial.id} initial={initial} mode={mode} onClose={close} />}
    </Dialog>
  );
}

function EditorBody({ initial, mode, onClose }: { initial: CueTemplate; mode: "new" | "edit"; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language.startsWith("zh") ? "zh" : "en";
  const [draft, setDraft] = useState<CueTemplate>(initial);
  const gamma = useProjectStore((s) => s.project.output.gamma);
  const saveUser = useCueTemplateStore((s) => s.saveUser);
  const validation = useMemo(() => validateTemplate(draft), [draft]);
  const kind = templateKind(draft);
  const update = (patch: Partial<CueTemplate>) =>
    setDraft((d) => {
      const next = { ...d, ...patch } as CueTemplate & Record<string, unknown>;
      for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
      return next;
    });
  const fill = templateSwatch(draft, gamma);
  const spreadColors = kind === "color" ? draft.spread?.colors : undefined;
  const setSpreadColors = (colors: { colors: ColorValue[]; blend?: ColorBlend } | undefined) => {
    const spread = { ...draft.spread, colors };
    if (!colors) delete spread.colors;
    update({ spread: Object.keys(spread).length > 0 ? spread : undefined });
  };

  const save = async () => {
    if (!validation.ok) return;
    const next = upsertTemplate(useCueTemplateStore.getState().user, validation.template);
    if (await saveUser(next)) {
      announce(t("editor.templateEditor.saved", { name: templateName(validation.template, i18n.language) }));
      onClose();
    } else {
      toast.error(t(`editor.templates.errors.${useCueTemplateStore.getState().error ?? "io"}`));
    }
  };

  const section = (title: string, children: ReactNode) => (
    <section aria-label={title} className="grid content-start gap-2 rounded-md border border-border p-2.5">
      <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{title}</h4>
      {children}
    </section>
  );
  const row = "flex flex-wrap items-center gap-2";
  const label = "w-20 shrink-0 text-xs text-muted-foreground";
  const nameText = templateName(draft, lang);
  const num = (text: string, value: number, unit: string, commit: (n: number) => void, max: number) => (
    <div className={row}>
      <span className={label}>{text}</span>
      <CommitInput
        className="num h-7 w-24 px-2 text-xs"
        inputMode="numeric"
        label={text}
        value={value}
        onCommit={(v) => {
          const n = Number(v);
          if (Number.isFinite(n)) commit(Math.min(max, Math.max(0, n)));
        }}
      />
      <span className="text-xs text-muted-foreground">{unit}</span>
    </div>
  );
  const lengthKind = draft.length?.kind ?? "default";

  return (
    <DialogContent className="max-h-[88vh] max-w-3xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{t(mode === "new" ? "editor.templateEditor.titleNew" : "editor.templateEditor.titleEdit")}</DialogTitle>
        <DialogDescription>{t("editor.templateEditor.description")}</DialogDescription>
      </DialogHeader>

      <div className="flex items-center gap-3 rounded-md bg-surface-1 px-3 py-2">
        <span
          aria-hidden
          data-testid="template-preview"
          className={cn("h-6 w-16 shrink-0 rounded-sm border border-border", fill.neutral && "hatch-neutral")}
          style={fill.background ? { background: fill.background } : undefined}
        />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{nameText}</span>
        <span className="rounded-sm bg-surface-3 px-1.5 py-0.5 text-[11px] text-muted-foreground">{t(`editor.templateEditor.kinds.${kind}`)}</span>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {section(
          t("editor.templateEditor.basics"),
          <>
            <div className={row}>
              <span className={label}>{t("editor.templateEditor.name")}</span>
              <CommitInput
                className="h-7 flex-1 px-2 text-xs"
                label={t("editor.templateEditor.name")}
                value={nameText}
                onCommit={(v) => {
                  const text = v.trim();
                  if (text) update({ name: typeof draft.name === "object" ? { ...draft.name, [lang]: text } : text });
                }}
              />
            </div>
            <div className={row}>
              <span className={label}>{t("editor.templateEditor.group")}</span>
              <CommitInput className="h-7 flex-1 px-2 text-xs" label={t("editor.templateEditor.group")} value={draft.group} onCommit={(v) => update({ group: v.trim() || CUSTOM_GROUP })} />
            </div>
            <div className={row}>
              <span className={label}>{t("editor.templateEditor.tags")}</span>
              <CommitInput
                className="h-7 flex-1 px-2 text-xs"
                label={t("editor.templateEditor.tags")}
                value={(draft.tags ?? []).join(", ")}
                onCommit={(v) => {
                  const tags = [...new Set(v.split(/[,，]/).map((x) => x.trim().slice(0, 24)).filter(Boolean))].slice(0, 8);
                  update({ tags: tags.length > 0 ? tags : undefined });
                }}
              />
            </div>
            <p className="text-[11px] text-muted-foreground">{t("editor.templateEditor.tagsHint")}</p>
            <div className={row}>
              <span className={label}>{t("editor.templateEditor.note")}</span>
              <CommitInput
                className="h-7 flex-1 px-2 text-xs"
                label={t("editor.templateEditor.note")}
                value={draft.note ?? ""}
                onCommit={(v) => update({ note: v.trim() ? v.trim().slice(0, 200) : undefined })}
              />
            </div>
          </>,
        )}

        {section(
          t("editor.templateEditor.advanced"),
          <>
            {num(t("editor.cue.brightness"), draft.brightness, "%", (n) => update({ brightness: Math.round(n) }), 100)}
            {num(t("editor.cue.fadeIn"), draft.fadeInMs, t("editor.templateEditor.msUnit"), (n) => update({ fadeInMs: Math.round(n) }), 600_000)}
            {num(t("editor.cue.fadeOut"), draft.fadeOutMs, t("editor.templateEditor.msUnit"), (n) => update({ fadeOutMs: Math.round(n) }), 600_000)}
            <div className={row}>
              <span className={label}>{t("editor.cue.easing")}</span>
              <Select value={draft.easing ?? "linear"} onValueChange={(v) => update({ easing: v === "linear" ? undefined : (v as Easing) })}>
                <SelectTrigger className="h-7 w-36 text-xs" aria-label={t("editor.cue.easing")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EASINGS.map((e) => (
                    <SelectItem key={e} value={e}>
                      {t(`editor.cue.easings.${e}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className={row}>
              <span className={label}>{t("editor.templateEditor.length")}</span>
              <Segmented
                size="xs"
                ariaLabel={t("editor.templateEditor.lengthUnit")}
                value={lengthKind}
                onChange={(k) =>
                  update({
                    length:
                      k === "default"
                        ? undefined
                        : k === "ms"
                          ? { kind: "ms", ms: DEFAULT_CUE_MS }
                          : { kind: "beats", beats: 4 },
                  })
                }
                options={[
                  { value: "default", label: t("editor.templateEditor.lengths.default") },
                  { value: "ms", label: t("editor.templateEditor.lengths.ms") },
                  { value: "beats", label: t("editor.templateEditor.lengths.beats") },
                ]}
              />
              {draft.length && (
                <CommitInput
                  className="num h-7 w-20 px-2 text-xs"
                  inputMode="numeric"
                  label={t("editor.templateEditor.lengthValue")}
                  value={draft.length.kind === "ms" ? draft.length.ms / 1000 : draft.length.beats}
                  onCommit={(v) => {
                    const n = Number(v);
                    if (!Number.isFinite(n) || n <= 0) return;
                    update({
                      length:
                        draft.length?.kind === "beats"
                          ? { kind: "beats", beats: Math.min(1024, Math.max(0.25, n)) }
                          : { kind: "ms", ms: Math.min(3_600_000, Math.max(100, Math.round(n * 1000))) },
                    });
                  }}
                />
              )}
            </div>
            {!draft.length && <p className="text-[11px] text-muted-foreground">{t("editor.templateEditor.lengthDefaultHint", { s: (kind === "effect" ? EFFECT_CLIP_MS : DEFAULT_CUE_MS) / 1000 })}</p>}
          </>,
        )}
      </div>

      {section(
        t(kind === "color" ? "editor.templateEditor.color" : "editor.templateEditor.representative"),
        <>
          {kind !== "color" && <p className="text-[11px] text-muted-foreground">{t("editor.templateEditor.representativeHint")}</p>}
          <ColorPicker value={draft.color} gamma={gamma} onCommit={(color) => update({ color })} />
          {kind === "color" && (
            <div className="grid gap-2 rounded-md bg-surface-1 p-2">
              <label className="flex cursor-pointer items-center gap-1.5 text-xs">
                <Checkbox
                  aria-label={t("editor.templateEditor.multiColor")}
                  checked={spreadColors !== undefined}
                  onCheckedChange={(v) =>
                    setSpreadColors(
                      v === true
                        ? { colors: [structuredClone(draft.color), { kind: "rgb", rgb: [0, 0, 255] }], blend: "smooth" }
                        : undefined,
                    )
                  }
                />
                {t("editor.templateEditor.multiColor")}
              </label>
              <p className="text-[11px] text-muted-foreground">{t("editor.templateEditor.multiColorHint")}</p>
              {spreadColors && (
                <div className="flex flex-wrap items-center gap-1">
                  {spreadColors.colors.map((c, i) => (
                    <span key={i} className="flex items-center">
                      {c.kind === "rgb" ? (
                        <SwatchInput
                          label={t("editor.templateEditor.colorN", { n: i + 1 })}
                          rgb={c.rgb}
                          onChange={(rgb) => setSpreadColors({ ...spreadColors, colors: spreadColors.colors.map((x, k) => (k === i ? { ...c, rgb } : x)) })}
                        />
                      ) : (
                        <span
                          aria-label={t("editor.templateEditor.colorN", { n: i + 1 })}
                          role="img"
                          className="h-6 w-8 rounded-sm border border-border bg-(--cue-color)"
                          style={{ "--cue-color": `rgb(${colorValueRgb(c, gamma).join(" ")})` } as CSSProperties}
                        />
                      )}
                      {spreadColors.colors.length > 2 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-5"
                          aria-label={t("editor.templateEditor.removeColor", { n: i + 1 })}
                          onClick={() => setSpreadColors({ ...spreadColors, colors: spreadColors.colors.filter((_, k) => k !== i) })}
                        >
                          <X aria-hidden className="size-3" />
                        </Button>
                      )}
                    </span>
                  ))}
                  {spreadColors.colors.length < MAX_SPREAD_COLORS && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-6"
                      aria-label={t("editor.templateEditor.addColor")}
                      title={t("editor.templateEditor.addColor")}
                      onClick={() => setSpreadColors({ ...spreadColors, colors: [...spreadColors.colors, { kind: "rgb", rgb: [255, 255, 255] }] })}
                    >
                      <Plus aria-hidden className="size-3.5" />
                    </Button>
                  )}
                  <Select value={spreadColors.blend ?? "smooth"} onValueChange={(v) => setSpreadColors({ ...spreadColors, blend: v as ColorBlend })}>
                    <SelectTrigger className="ml-2 h-7 w-28 text-xs" aria-label={t("editor.templateEditor.blend")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {BLENDS.map((b) => (
                        <SelectItem key={b} value={b}>
                          {t(`editor.effectEditor.blends.${b}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          )}
        </>,
      )}

      {kind === "effect" &&
        draft.fx &&
        section(
          t("editor.templateEditor.fxParams"),
          <EffectParamsPanel
            def={draft.fx.def}
            params={draft.fx.params}
            onChange={(patch) => draft.fx && update({ fx: { def: draft.fx.def, params: mergeEffectParams(draft.fx.def, draft.fx.params, patch) } })}
            onReset={() => draft.fx && update({ fx: { def: draft.fx.def, params: defaultEffectParams(draft.fx.def) } })}
          />,
        )}

      {kind === "look" && draft.look && section(t("editor.templateEditor.lookSummary"), <LookSummary look={draft.look} spread={draft.spread !== undefined} />)}

      <div className="flex flex-wrap items-center justify-between gap-2">
        {validation.ok ? (
          <p role="status" className="text-xs text-muted-foreground">
            {t("editor.templateEditor.valid")}
          </p>
        ) : (
          <p role="alert" className="flex items-center gap-1.5 text-xs text-warning">
            <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
            {t("editor.templateEditor.invalid", { message: validation.message })}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("editor.duration.cancel")}
          </Button>
          <Button type="button" disabled={!validation.ok} onClick={() => void save()}>
            {t("editor.templateEditor.save")}
          </Button>
        </div>
      </div>
    </DialogContent>
  );
}

/** 一层参数的种类（固定 / 关键帧 / 曲线 / 颜色序列）。 */
type LayerKind = (Param<number> | ColorParam)["kind"];

/** 外观模板的各层概要（只读）。 */
function LookSummary({ look, spread }: { look: Look; spread: boolean }) {
  const { t } = useTranslation();
  const rows: { name: string; kind: LayerKind }[] = [
    ...(look.intensity ? [{ name: t("editor.look.intensity"), kind: look.intensity.kind }] : []),
    ...(look.color ? [{ name: t("editor.look.color"), kind: look.color.kind }] : []),
    ...Object.entries(look.attrs ?? {}).flatMap(([k, p]) => (p ? [{ name: t(`fixtures.functions.${k}`), kind: p.kind }] : [])),
  ];
  return (
    <>
      <p className="text-[11px] text-muted-foreground">{t("editor.templateEditor.lookHint")}</p>
      <ul className="grid gap-1 text-xs">
        {rows.map((r) => (
          <li key={r.name} className="flex items-center justify-between gap-2 rounded-sm bg-surface-1 px-2 py-1">
            <span>{r.name}</span>
            <span className="text-muted-foreground">{t(`editor.templateEditor.layerKinds.${r.kind}`)}</span>
          </li>
        ))}
        {spread && <li className="rounded-sm bg-surface-1 px-2 py-1 text-muted-foreground">{t("editor.templateEditor.hasSpread")}</li>}
      </ul>
    </>
  );
}

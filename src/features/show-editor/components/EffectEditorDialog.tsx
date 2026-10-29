import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Pause, Play, Plus, Trash2, TriangleAlert, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Segmented } from "@/shared/components/Segmented";
import { announce } from "@/shared/stores/announcerStore";
import { createDmxEvaluator } from "../lib/dmxPreview";
import { createPreviewEvaluator } from "../lib/color";
import { formatSteps, parseSteps } from "../lib/curveTiming";
import { ATTR_KEY_LIST, type EffectColorLayer, type EffectDef, type EffectLayer, type EffectParamDecl, type ParamRef } from "../lib/effectDefSchema";
import { effectPreview, validateEffect } from "../lib/effectDraft";
import { localizedText, upsertEffect } from "../lib/effectLibrary";
import { periodMs } from "../lib/effects";
import type { AttrKey, ColorBlend, Curve, Rgb, WaveShape } from "../lib/project";
import { useEngine } from "../engine/useEngine";
import { useEffectEditorStore } from "../stores/useEffectEditorStore";
import { useEffectLibraryStore } from "../stores/useEffectLibraryStore";
import { useProjectStore } from "../stores/useProjectStore";
import { CommitInput } from "./CommitInput";
import { EFFECT_ICONS } from "./effectIcons";

const SHAPES: readonly WaveShape[] = ["sine", "triangle", "saw", "square", "ramp", "random", "noise", "steps"];
const CURVES: readonly Curve[] = ["linear", "hold", "easeIn", "easeOut", "easeInOut", "sCurve"];
const BLENDS: readonly ColorBlend[] = ["smooth", "step", "hue"];
const PARAM_TYPES: readonly EffectParamDecl["type"][] = ["percent", "number", "color", "colors", "choice", "boolean"];

const isRef = (v: unknown): v is ParamRef => typeof v === "string" && v.startsWith("$");
const toHex = (rgb: Rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
const fromHex = (hex: string): Rgb | null => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
};

/**
 * 解析数值字段：数字，或 `$参数名`（引用可调参数）；空为清除。
 *
 * @param text 输入。
 * @returns 值；无法解析时为 `null`。
 */
function parseNum(text: string): number | ParamRef | undefined | null {
  const s = text.trim();
  if (s === "") return undefined;
  if (/^\$[\w.-]{1,32}$/.test(s)) return s as ParamRef;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * 特效编辑器：在软件里新建 / 修改“我的特效”，不必手改 `effects.json`。
 *
 * 分区：基本信息、默认参数、外观层（强度 / 颜色 / 属性，每层固定值或波形）、可调参数声明、实时预览
 * （一排 8 台虚拟灯，引擎求值，与实际输出一致）。保存前按特效文件的规则校验，有问题时显示原因并禁止保存。
 */
export function EffectEditorDialog() {
  const initial = useEffectEditorStore((s) => s.draft);
  const mode = useEffectEditorStore((s) => s.mode);
  const close = useEffectEditorStore((s) => s.close);
  return (
    <Dialog open={initial !== null} onOpenChange={(open) => !open && close()}>
      {initial && <EditorBody key={initial.id} initial={initial} mode={mode} onClose={close} />}
    </Dialog>
  );
}

function EditorBody({ initial, mode, onClose }: { initial: EffectDef; mode: "new" | "edit"; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language.startsWith("zh") ? "zh" : "en";
  const [draft, setDraft] = useState<EffectDef>(initial);
  const user = useEffectLibraryStore((s) => s.user);
  const saveUser = useEffectLibraryStore((s) => s.saveUser);
  const validation = useMemo(() => validateEffect(draft), [draft]);
  const update = (patch: Partial<EffectDef>) => setDraft((d) => ({ ...d, ...patch }));
  const setLook = (patch: Partial<EffectDef["look"]>) =>
    setDraft((d) => {
      const look = { ...d.look, ...patch };
      for (const k of Object.keys(look) as (keyof EffectDef["look"])[]) if (look[k] === undefined) delete look[k];
      return { ...d, look };
    });
  const textOf = (v: EffectDef["name"] | undefined) => localizedText(v, i18n.language);
  const withText = (v: EffectDef["name"] | undefined, text: string): EffectDef["name"] =>
    typeof v === "object" ? { ...v, [lang]: text } : text;
  const groups = useMemo(() => [...new Set(["custom", ...user.map((e) => e.group)])], [user]);
  const params = draft.params ?? [];
  const setParams = (next: EffectParamDecl[]) => update({ params: next.length > 0 ? next : undefined });
  const conflict = mode === "new" && user.some((e) => e.id === draft.id);

  const save = async () => {
    if (!validation.ok || conflict) return;
    const next = upsertEffect(useEffectLibraryStore.getState().user, validation.def);
    if (await saveUser(next)) {
      announce(t("editor.effectEditor.saved", { name: textOf(validation.def.name) }));
      onClose();
    } else {
      toast.error(t(`editor.templates.errors.${useEffectLibraryStore.getState().error ?? "io"}`));
    }
  };

  const section = (title: string, children: ReactNode) => (
    <section aria-label={title} className="grid gap-2 rounded-md border border-border p-2.5">
      <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{title}</h4>
      {children}
    </section>
  );
  const row = "flex flex-wrap items-center gap-2";
  const label = "w-20 shrink-0 text-xs text-muted-foreground";

  return (
    <DialogContent className="max-h-[88vh] max-w-3xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{t(mode === "new" ? "editor.effectEditor.titleNew" : "editor.effectEditor.titleEdit")}</DialogTitle>
        <DialogDescription>{t("editor.effectEditor.description")}</DialogDescription>
      </DialogHeader>

      <EffectPreviewStrip def={validation.ok ? validation.def : null} />

      <div className="grid gap-3 md:grid-cols-2">
        {section(
          t("editor.effectEditor.basics"),
          <>
            <div className={row}>
              <span className={label}>{t("editor.effectEditor.name")}</span>
              <CommitInput className="h-7 flex-1 px-2 text-xs" label={t("editor.effectEditor.name")} value={textOf(draft.name)} onCommit={(v) => update({ name: withText(draft.name, v.trim()) })} />
            </div>
            <div className={row}>
              <span className={label}>{t("editor.effectEditor.id")}</span>
              <CommitInput className="num h-7 flex-1 px-2 text-xs" label={t("editor.effectEditor.id")} value={draft.id} onCommit={(v) => mode === "new" && update({ id: v.trim() })} />
            </div>
            {conflict && <p className="text-[11px] text-warning">{t("editor.effectEditor.idTaken")}</p>}
            <div className={row}>
              <span className={label}>{t("editor.effectEditor.group")}</span>
              <CommitInput className="h-7 flex-1 px-2 text-xs" label={t("editor.effectEditor.group")} value={draft.group} onCommit={(v) => update({ group: v.trim() || "custom" })} />
              <span className="sr-only">{groups.join(", ")}</span>
            </div>
            <div className={row}>
              <span className={label}>{t("editor.effectEditor.icon")}</span>
              <Select value={draft.icon ?? "sparkles"} onValueChange={(v) => update({ icon: v })}>
                <SelectTrigger className="h-7 w-36 text-xs" aria-label={t("editor.effectEditor.icon")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(EFFECT_ICONS).map(([name, Icon]) => (
                    <SelectItem key={name} value={name}>
                      <span className="flex items-center gap-1.5">
                        <Icon aria-hidden className="size-3.5" />
                        {name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className={row}>
              <span className={label}>{t("editor.effectEditor.hint")}</span>
              <CommitInput className="h-7 flex-1 px-2 text-xs" label={t("editor.effectEditor.hint")} value={textOf(draft.hint)} onCommit={(v) => update({ hint: v.trim() ? withText(draft.hint, v.trim()) : undefined })} />
            </div>
            <div className={row}>
              <span className={label}>{t("editor.effectEditor.scale")}</span>
              <Segmented
                size="xs"
                ariaLabel={t("editor.effectEditor.scale")}
                value={draft.scale}
                onChange={(scale) => update({ scale, size: scale === "fraction" ? Math.min(0.5, draft.size) : draft.size <= 0.5 ? 100 : draft.size })}
                options={[
                  { value: "percent", label: t("editor.effectEditor.scales.percent") },
                  { value: "fraction", label: t("editor.effectEditor.scales.fraction") },
                ]}
              />
            </div>
          </>,
        )}

        {section(
          t("editor.effectEditor.defaults"),
          <>
            <div className={row}>
              <span className={label}>{t("editor.effectLib.speed")}</span>
              <CommitInput
                className="num h-7 w-20 px-2 text-xs"
                inputMode="numeric"
                label={t("editor.effectLib.speedValue")}
                value={draft.period.kind === "beats" ? draft.period.beats : draft.period.ms}
                onCommit={(v) => {
                  const n = Number(v);
                  if (Number.isFinite(n) && n > 0) update({ period: draft.period.kind === "beats" ? { kind: "beats", beats: n } : { kind: "ms", ms: Math.round(n) } });
                }}
              />
              <Segmented
                size="xs"
                ariaLabel={t("editor.effectLib.speedUnit")}
                value={draft.period.kind}
                onChange={(k) => {
                  const ms = periodMs(draft.period, null);
                  update({ period: k === "ms" ? { kind: "ms", ms: Math.round(ms) } : { kind: "beats", beats: Math.max(0.125, Math.round((ms / 500) * 4) / 4) } });
                }}
                options={[
                  { value: "beats", label: t("editor.effectLib.beats") },
                  { value: "ms", label: t("editor.effectLib.ms") },
                ]}
              />
            </div>
            <div className={row}>
              <span className={label}>{t("editor.effectLib.size")}</span>
              <CommitInput
                className="num h-7 w-20 px-2 text-xs"
                inputMode="numeric"
                label={t("editor.effectLib.sizeValue")}
                value={draft.scale === "fraction" ? Math.round(draft.size * 200) : Math.round(draft.size)}
                onCommit={(v) => {
                  const n = Number(v);
                  if (Number.isFinite(n)) update({ size: draft.scale === "fraction" ? Math.min(100, Math.max(0, n)) / 200 : Math.min(100, Math.max(0, n)) });
                }}
              />
              <span className="text-xs text-muted-foreground">%</span>
            </div>
            <div className={row}>
              <span className={label}>{t("editor.effectLib.spread")}</span>
              <CommitInput
                className="num h-7 w-20 px-2 text-xs"
                inputMode="numeric"
                label={t("editor.effectLib.spreadValue")}
                value={Math.round(draft.spread * 100)}
                onCommit={(v) => {
                  const n = Number(v);
                  if (Number.isFinite(n)) update({ spread: Math.min(400, Math.max(0, n)) / 100 });
                }}
              />
              <span className="text-xs text-muted-foreground">%</span>
            </div>
            <div className={row}>
              <span className={label}>{t("editor.effectEditor.spreadBy")}</span>
              <Select value={draft.spreadBy} onValueChange={(v) => update({ spreadBy: v as EffectDef["spreadBy"] })}>
                <SelectTrigger className="h-7 w-36 text-xs" aria-label={t("editor.effectEditor.spreadBy")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["phase", "hue", "delay", "none"] as const).map((s) => (
                    <SelectItem key={s} value={s}>
                      {t(`editor.effectEditor.spreadBys.${s}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </>,
        )}
      </div>

      {section(
        t("editor.effectEditor.layers"),
        <>
          <p className="text-[11px] text-muted-foreground">{t("editor.effectEditor.layersHint")}</p>
          <LayerSlot
            title={t("editor.look.intensity")}
            present={draft.look.intensity !== undefined}
            onAdd={() => setLook({ intensity: { shape: "sine", lo: 0, hi: 1 } })}
            onRemove={() => setLook({ intensity: undefined })}
          >
            {draft.look.intensity && <NumLayerEditor name={t("editor.look.intensity")} layer={draft.look.intensity} params={params} onChange={(intensity) => setLook({ intensity })} />}
          </LayerSlot>
          <LayerSlot
            title={t("editor.look.color")}
            present={draft.look.color !== undefined}
            onAdd={() => setLook({ color: { rgb: [255, 0, 0] } })}
            onRemove={() => setLook({ color: undefined })}
          >
            {draft.look.color && <ColorLayerEditor layer={draft.look.color} params={params} onChange={(color) => setLook({ color })} />}
          </LayerSlot>
          {(Object.entries(draft.look.attrs ?? {}) as [AttrKey, EffectLayer][]).map(([key, layer]) => (
            <LayerSlot
              key={key}
              title={t(`fixtures.functions.${key}`)}
              present
              onRemove={() => {
                const attrs = { ...draft.look.attrs };
                delete attrs[key];
                setLook({ attrs: Object.keys(attrs).length > 0 ? attrs : undefined });
              }}
            >
              <NumLayerEditor name={t(`fixtures.functions.${key}`)} layer={layer} params={params} onChange={(l) => setLook({ attrs: { ...draft.look.attrs, [key]: l } })} />
            </LayerSlot>
          ))}
          <div className={row}>
            <Select
              value=""
              onValueChange={(v) => setLook({ attrs: { ...draft.look.attrs, [v]: { shape: "sine", center: 0.5, amp: 1 } } })}
            >
              <SelectTrigger className="h-7 w-48 text-xs" aria-label={t("editor.effectEditor.addAttr")}>
                <SelectValue placeholder={t("editor.effectEditor.addAttr")} />
              </SelectTrigger>
              <SelectContent>
                {ATTR_KEY_LIST.filter((k) => !draft.look.attrs?.[k]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {t(`fixtures.functions.${k}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </>,
      )}

      {section(
        t("editor.effectEditor.params"),
        <>
          <p className="text-[11px] text-muted-foreground">{t("editor.effectEditor.paramsHint")}</p>
          {params.map((d, i) => (
            <ParamDeclEditor
              key={i}
              decl={d}
              lang={lang}
              onChange={(next) => setParams(params.map((x, k) => (k === i ? next : x)))}
              onRemove={() => setParams(params.filter((_, k) => k !== i))}
            />
          ))}
          <AddParam existing={params} onAdd={(d) => setParams([...params, d])} />
        </>,
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        {validation.ok ? (
          <p role="status" className="text-xs text-muted-foreground">
            {t("editor.effectEditor.valid")}
          </p>
        ) : (
          <p role="alert" className="flex items-center gap-1.5 text-xs text-warning">
            <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
            {t("editor.effectEditor.invalid", { message: validation.message })}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("editor.duration.cancel")}
          </Button>
          <Button type="button" disabled={!validation.ok || conflict} onClick={() => void save()}>
            {t("editor.effectEditor.save")}
          </Button>
        </div>
      </div>
    </DialogContent>
  );
}

/** 一层的外框：标题 + 添加 / 移除。 */
function LayerSlot({ title, present, onAdd, onRemove, children }: { title: string; present: boolean; onAdd?: () => void; onRemove: () => void; children?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-1.5 rounded-md bg-surface-1 p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">{title}</span>
        {present ? (
          <Button type="button" variant="ghost" size="icon" className="size-6" aria-label={t("editor.effectEditor.removeLayer", { name: title })} title={t("editor.effectEditor.removeLayer", { name: title })} onClick={onRemove}>
            <Trash2 aria-hidden className="size-3.5" />
          </Button>
        ) : (
          onAdd && (
            <Button type="button" variant="outline" size="sm" className="h-6 gap-1 px-2 text-xs" onClick={onAdd}>
              <Plus aria-hidden className="size-3.5" />
              {t("editor.effectEditor.addLayer", { name: title })}
            </Button>
          )
        )}
      </div>
      {present && children}
    </div>
  );
}

/** 数值字段：数字或 `$参数名`。 */
function NumField({ label, value, onCommit, hint }: { label: string; value: number | string | undefined; onCommit: (v: number | ParamRef | undefined) => void; hint?: string }) {
  const { t } = useTranslation();
  return (
    <label className="grid gap-0.5 text-[11px] text-muted-foreground" title={hint}>
      {label}
      <CommitInput
        className="num h-7 w-20 px-1.5 text-xs"
        label={label}
        value={value === undefined ? "" : String(value)}
        onCommit={(text) => {
          const v = parseNum(text);
          if (v === null) announce(t("editor.effectEditor.badNumber"));
          else onCommit(v);
        }}
      />
    </label>
  );
}

/** 强度 / 属性层：固定值或波形。 */
function NumLayerEditor({ name, layer, params, onChange }: { name: string; layer: EffectLayer; params: readonly EffectParamDecl[]; onChange: (l: EffectLayer) => void }) {
  const { t } = useTranslation();
  const wave = "shape" in layer;
  const set = (patch: Record<string, unknown>) => {
    const next = { ...layer, ...patch } as Record<string, unknown>;
    for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === false) delete next[k];
    onChange(next as EffectLayer);
  };
  const shapeChoices = params.filter((d) => d.type === "choice" && d.options.every((o) => (SHAPES as readonly string[]).includes(o.value)));
  const f = (key: string, label: string, hint?: string) => (
    <NumField label={`${name} · ${label}`} value={(layer as Record<string, number | string | undefined>)[key]} onCommit={(v) => set({ [key]: v })} hint={hint} />
  );
  return (
    <div className="grid gap-2">
      <Segmented
        size="xs"
        ariaLabel={t("editor.effectEditor.layerMode", { name })}
        value={wave ? "wave" : "value"}
        onChange={(m) => onChange(m === "value" ? { value: 1 } : { shape: "sine", lo: 0, hi: 1 })}
        options={[
          { value: "value", label: t("editor.effectEditor.fixed") },
          { value: "wave", label: t("editor.effectEditor.wave") },
        ]}
      />
      {!wave ? (
        <div className="flex flex-wrap gap-2">{f("value", t("editor.effectEditor.value"), t("editor.effectEditor.unitHint"))}</div>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-2">
            <label className="grid gap-0.5 text-[11px] text-muted-foreground">
              {t("editor.look.shape")}
              <Select value={layer.shape} onValueChange={(v) => set({ shape: v, ...(v === "steps" && !layer.steps ? { steps: [1, 0, 0, 0] } : {}) })}>
                <SelectTrigger className="h-7 w-32 text-xs" aria-label={`${name} · ${t("editor.look.shape")}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SHAPES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {t(`editor.look.shapes.${s}`)}
                    </SelectItem>
                  ))}
                  {shapeChoices.map((d) => (
                    <SelectItem key={d.id} value={`$${d.id}`}>
                      {t("editor.effectEditor.fromParam", { id: d.id })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            {f("lo", t("editor.effectEditor.lo"), t("editor.effectEditor.unitHint"))}
            {f("hi", t("editor.effectEditor.hi"), t("editor.effectEditor.unitHint"))}
            {f("center", t("editor.effectEditor.center"), t("editor.effectEditor.centerHint"))}
            {f("amp", t("editor.effectEditor.amp"))}
          </div>
          <div className="flex flex-wrap items-end gap-2">
            {f("cycles", t("editor.effectEditor.speedMult"), t("editor.effectEditor.speedMultHint"))}
            {f("phase", t("editor.look.phase"))}
            {f("duty", t("editor.curve.duty"), t("editor.effectEditor.dutyHint"))}
            {f("transition", t("editor.curve.transition"), t("editor.curve.transitionHint"))}
            <label className="grid gap-0.5 text-[11px] text-muted-foreground">
              {t("editor.curve.ease")}
              <Select value={layer.ease ?? "default"} onValueChange={(v) => set({ ease: v === "default" ? undefined : v })}>
                <SelectTrigger className="h-7 w-28 text-xs" aria-label={`${name} · ${t("editor.curve.ease")}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">{t("editor.curve.easeDefault")}</SelectItem>
                  {CURVES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {t(`editor.look.curves.${c}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </div>
          {layer.shape === "steps" && (
            <label className="grid gap-0.5 text-[11px] text-muted-foreground" title={t("editor.curve.stepsHint")}>
              {t("editor.curve.steps")}
              <CommitInput
                className="num h-7 px-1.5 text-xs"
                label={`${name} · ${t("editor.curve.steps")}`}
                value={formatSteps(layer.steps ?? [])}
                onCommit={(text) => {
                  const steps = parseSteps(text);
                  if (steps) set({ steps });
                  else announce(t("editor.curve.stepsInvalid"));
                }}
              />
            </label>
          )}
          <div className="flex flex-wrap gap-3">
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
              <Checkbox aria-label={`${name} · ${t("editor.curve.perFixture")}`} checked={layer.seed === true} onCheckedChange={(v) => set({ seed: v === true })} />
              {t("editor.curve.perFixture")}
            </label>
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground" title={t("editor.effectEditor.onceHint")}>
              <Checkbox aria-label={`${name} · ${t("editor.effectEditor.once")}`} checked={layer.once === true} onCheckedChange={(v) => set({ once: v === true })} />
              {t("editor.effectEditor.once")}
            </label>
          </div>
        </>
      )}
    </div>
  );
}

/** 颜色层：固定色或色表，可引用颜色 / 色表 / 过渡方式参数。 */
function ColorLayerEditor({ layer, params, onChange }: { layer: EffectColorLayer; params: readonly EffectParamDecl[]; onChange: (l: EffectColorLayer) => void }) {
  const { t } = useTranslation();
  const name = t("editor.look.color");
  const list = "colors" in layer;
  const colorParams = params.filter((d) => d.type === "color");
  const colorsParams = params.filter((d) => d.type === "colors");
  const blendParams = params.filter((d) => d.type === "choice" && d.options.every((o) => (BLENDS as readonly string[]).includes(o.value)));
  return (
    <div className="grid gap-2">
      <Segmented
        size="xs"
        ariaLabel={t("editor.effectEditor.layerMode", { name })}
        value={list ? "list" : "fixed"}
        onChange={(m) => onChange(m === "fixed" ? { rgb: [255, 0, 0] } : { colors: [[255, 0, 0], [0, 0, 255]], blend: "smooth" })}
        options={[
          { value: "fixed", label: t("editor.effectEditor.fixedColor") },
          { value: "list", label: t("editor.effectEditor.colorList") },
        ]}
      />
      {!list ? (
        <div className="flex flex-wrap items-center gap-2">
          {isRef(layer.rgb) ? (
            <span className="num text-xs">{layer.rgb}</span>
          ) : (
            <SwatchInput label={name} rgb={layer.rgb} onChange={(rgb) => onChange({ rgb })} />
          )}
          <RefSelect label={t("editor.effectEditor.bindParam")} value={isRef(layer.rgb) ? layer.rgb : ""} options={colorParams} onChange={(v) => onChange({ rgb: v ?? [255, 0, 0] })} />
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1">
            {isRef(layer.colors) ? (
              <span className="num text-xs">{layer.colors}</span>
            ) : (
              <>
                {layer.colors.map((rgb, i) => (
                  <span key={i} className="flex items-center">
                    <SwatchInput label={t("editor.effectLib.colorN", { name, n: i + 1 })} rgb={rgb} onChange={(c) => onChange({ ...layer, colors: (layer.colors as Rgb[]).map((x, k) => (k === i ? c : x)) })} />
                    {layer.colors.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-5"
                        aria-label={t("editor.effectLib.removeColor", { n: i + 1 })}
                        onClick={() => onChange({ ...layer, colors: (layer.colors as Rgb[]).filter((_, k) => k !== i) })}
                      >
                        <X aria-hidden className="size-3" />
                      </Button>
                    )}
                  </span>
                ))}
                {layer.colors.length < 16 && (
                  <Button type="button" variant="ghost" size="icon" className="size-6" aria-label={t("editor.effectLib.addColor", { name })} onClick={() => onChange({ ...layer, colors: [...(layer.colors as Rgb[]), [255, 255, 255]] })}>
                    <Plus aria-hidden className="size-3.5" />
                  </Button>
                )}
              </>
            )}
            <RefSelect label={t("editor.effectEditor.bindParam")} value={isRef(layer.colors) ? layer.colors : ""} options={colorsParams} onChange={(v) => onChange({ ...layer, colors: v ?? [[255, 0, 0], [0, 0, 255]] })} />
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="grid gap-0.5 text-[11px] text-muted-foreground">
              {t("editor.effectEditor.blend")}
              <Select value={layer.blend ?? "smooth"} onValueChange={(v) => onChange({ ...layer, blend: v as ColorBlend | ParamRef })}>
                <SelectTrigger className="h-7 w-32 text-xs" aria-label={`${name} · ${t("editor.effectEditor.blend")}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BLENDS.map((b) => (
                    <SelectItem key={b} value={b}>
                      {t(`editor.effectEditor.blends.${b}`)}
                    </SelectItem>
                  ))}
                  {blendParams.map((d) => (
                    <SelectItem key={d.id} value={`$${d.id}`}>
                      {t("editor.effectEditor.fromParam", { id: d.id })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <NumField
              label={`${name} · ${t("editor.curve.transition")}`}
              value={layer.transition}
              onCommit={(v) => {
                const next = { ...layer, transition: v };
                if (v === undefined) delete next.transition;
                onChange(next);
              }}
              hint={t("editor.curve.transitionHint")}
            />
          </div>
        </>
      )}
    </div>
  );
}

/** 绑定到某个参数（下拉；“不绑定”为直接写值）。 */
function RefSelect({ label, value, options, onChange }: { label: string; value: string; options: readonly EffectParamDecl[]; onChange: (ref: ParamRef | undefined) => void }) {
  const { t } = useTranslation();
  if (options.length === 0) return null;
  return (
    <Select value={value || "none"} onValueChange={(v) => onChange(v === "none" ? undefined : (v as ParamRef))}>
      <SelectTrigger className="h-7 w-36 text-xs" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none">{t("editor.effectEditor.noBinding")}</SelectItem>
        {options.map((d) => (
          <SelectItem key={d.id} value={`$${d.id}`}>
            {t("editor.effectEditor.fromParam", { id: d.id })}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** 一个颜色输入（拖动取色时只改草稿，失去焦点时提交）。 */
export function SwatchInput({ label, rgb, onChange }: { label: string; rgb: Rgb; onChange: (rgb: Rgb) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      type="color"
      aria-label={label}
      title={label}
      value={draft ?? toHex(rgb)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const c = draft ? fromHex(draft) : null;
        setDraft(null);
        if (c) onChange(c);
      }}
      className="h-6 w-8 cursor-pointer rounded-sm border border-border bg-transparent p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    />
  );
}

/** 一个可调参数的声明。 */
function ParamDeclEditor({ decl, lang, onChange, onRemove }: { decl: EffectParamDecl; lang: "zh" | "en"; onChange: (d: EffectParamDecl) => void; onRemove: () => void }) {
  const { t } = useTranslation();
  const labelText = localizedText(decl.label, lang);
  const name = `$${decl.id}`;
  const num = (label: string, value: number, commit: (n: number) => void) => (
    <label className="grid gap-0.5 text-[11px] text-muted-foreground">
      {label}
      <CommitInput
        className="num h-7 w-20 px-1.5 text-xs"
        inputMode="numeric"
        label={`${name} · ${label}`}
        value={value}
        onCommit={(v) => {
          const n = Number(v);
          if (Number.isFinite(n)) commit(n);
        }}
      />
    </label>
  );
  return (
    <div role="group" aria-label={t("editor.effectEditor.paramOf", { id: decl.id })} className="flex flex-wrap items-end gap-2 rounded-md bg-surface-1 p-2">
      <span className="num rounded bg-surface-3 px-1.5 py-0.5 text-xs">{name}</span>
      <span className="text-[11px] text-muted-foreground">{t(`editor.effectEditor.paramTypes.${decl.type}`)}</span>
      <label className="grid gap-0.5 text-[11px] text-muted-foreground">
        {t("editor.effectEditor.paramLabel")}
        <CommitInput
          className="h-7 w-28 px-1.5 text-xs"
          label={`${name} · ${t("editor.effectEditor.paramLabel")}`}
          value={labelText}
          onCommit={(v) => onChange({ ...decl, label: v.trim() ? (typeof decl.label === "object" ? { ...decl.label, [lang]: v.trim() } : v.trim()) : undefined })}
        />
      </label>
      {decl.type === "number" && (
        <>
          {num(t("editor.effectEditor.min"), decl.min, (n) => onChange({ ...decl, min: n }))}
          {num(t("editor.effectEditor.max"), decl.max, (n) => onChange({ ...decl, max: n }))}
          {num(t("editor.effectEditor.default"), decl.default, (n) => onChange({ ...decl, default: n }))}
        </>
      )}
      {decl.type === "percent" && num(t("editor.effectEditor.defaultPct"), Math.round(decl.default * 100), (n) => onChange({ ...decl, default: Math.min(100, Math.max(0, n)) / 100 }))}
      {decl.type === "color" && <SwatchInput label={`${name} · ${t("editor.effectEditor.default")}`} rgb={decl.default} onChange={(rgb) => onChange({ ...decl, default: rgb })} />}
      {decl.type === "colors" && (
        <span className="flex items-center gap-1">
          {decl.default.map((rgb, i) => (
            <SwatchInput key={i} label={`${name} · ${i + 1}`} rgb={rgb} onChange={(c) => onChange({ ...decl, default: decl.default.map((x, k) => (k === i ? c : x)) })} />
          ))}
          <Button type="button" variant="ghost" size="icon" className="size-6" aria-label={t("editor.effectLib.addColor", { name })} onClick={() => onChange({ ...decl, default: [...decl.default, [255, 255, 255]] })}>
            <Plus aria-hidden className="size-3.5" />
          </Button>
        </span>
      )}
      {decl.type === "choice" && (
        <label className="grid gap-0.5 text-[11px] text-muted-foreground" title={t("editor.effectEditor.optionsHint")}>
          {t("editor.effectEditor.options")}
          <CommitInput
            className="num h-7 w-48 px-1.5 text-xs"
            label={`${name} · ${t("editor.effectEditor.options")}`}
            value={decl.options.map((o) => o.value).join(", ")}
            onCommit={(v) => {
              const values = [...new Set(v.split(/[\s,，]+/).filter(Boolean))].slice(0, 16);
              if (values.length === 0) return;
              onChange({ ...decl, options: values.map((value) => decl.options.find((o) => o.value === value) ?? { value }), default: values.includes(decl.default) ? decl.default : values[0] });
            }}
          />
        </label>
      )}
      {decl.type === "boolean" && (
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <Checkbox aria-label={`${name} · ${t("editor.effectEditor.default")}`} checked={decl.default} onCheckedChange={(v) => onChange({ ...decl, default: v === true })} />
          {t("editor.effectEditor.default")}
        </label>
      )}
      <Button type="button" variant="ghost" size="icon" className="ml-auto size-6" aria-label={t("editor.effectEditor.removeParam", { id: decl.id })} onClick={onRemove}>
        <Trash2 aria-hidden className="size-3.5" />
      </Button>
    </div>
  );
}

/** 新增一个可调参数：选类型、填 `id`。 */
function AddParam({ existing, onAdd }: { existing: readonly EffectParamDecl[]; onAdd: (d: EffectParamDecl) => void }) {
  const { t } = useTranslation();
  const [type, setType] = useState<EffectParamDecl["type"]>("percent");
  const nextId = () => {
    for (let n = 1; ; n += 1) if (!existing.some((d) => d.id === `p${n}`)) return `p${n}`;
  };
  const make = (id: string): EffectParamDecl => {
    switch (type) {
      case "number":
        return { id, type, min: 0, max: 1, default: 0.5 };
      case "percent":
        return { id, type, default: 0.5 };
      case "color":
        return { id, type, default: [255, 255, 255] };
      case "colors":
        return { id, type, default: [[255, 0, 0], [0, 0, 255]], min: 2, max: 8 };
      case "choice":
        return { id, type, default: "sine", options: [{ value: "sine" }, { value: "square" }] };
      case "boolean":
        return { id, type, default: false };
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={type} onValueChange={(v) => setType(v as EffectParamDecl["type"])}>
        <SelectTrigger className="h-7 w-32 text-xs" aria-label={t("editor.effectEditor.paramType")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PARAM_TYPES.map((p) => (
            <SelectItem key={p} value={p}>
              {t(`editor.effectEditor.paramTypes.${p}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button type="button" variant="outline" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={() => onAdd(make(nextId()))}>
        <Plus aria-hidden className="size-3.5" />
        {t("editor.effectEditor.addParam")}
      </Button>
    </div>
  );
}

/**
 * 实时预览：一排 8 台虚拟灯（引擎求值，与实际输出一致），显示颜色与亮度；有 Pan / Tilt 层时在色块下画出光点位置。
 * 尊重“减少动态效果”：默认不自动播放。
 */
function EffectPreviewStrip({ def }: { def: EffectDef | null }) {
  const { t } = useTranslation();
  const engine = useEngine();
  const tempo = useProjectStore((s) => s.project.tempo);
  const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const [playing, setPlaying] = useState(!reduced);
  const [tMs, setT] = useState(0);
  const preview = useMemo(() => (def ? effectPreview(def, undefined, tempo) : null), [def, tempo]);
  const colorsAt = useMemo(() => (preview ? createPreviewEvaluator(preview.project, engine) : null), [preview, engine]);
  const dmxAt = useMemo(() => (preview ? createDmxEvaluator(preview.project, engine) : null), [preview, engine]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const start = performance.now() - tMs;
    const tick = (now: number) => {
      setT((now - start) % 60_000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // 只在开始 / 暂停时重启动画循环
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  if (!preview || !colorsAt || !dmxAt) {
    return <p className="rounded-md border border-dashed border-border p-3 text-center text-xs text-muted-foreground">{t("editor.effectEditor.previewInvalid")}</p>;
  }
  const colors = colorsAt(tMs);
  const frame = dmxAt(tMs, 0);
  const pan = preview.offsets.get("pan");
  const tilt = preview.offsets.get("tilt");
  const moves = def?.look.attrs?.pan !== undefined || def?.look.attrs?.tilt !== undefined || def?.fan?.attr === "pan";
  return (
    <div role="group" aria-label={t("editor.effectEditor.preview")} className="flex items-center gap-2 rounded-md bg-stage-bg p-2">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        aria-label={t(playing ? "editor.effectEditor.pause" : "editor.effectEditor.play")}
        aria-pressed={playing}
        onClick={() => setPlaying(!playing)}
      >
        {playing ? <Pause aria-hidden /> : <Play aria-hidden />}
      </Button>
      <ul className="grid flex-1 grid-cols-8 gap-1.5" aria-hidden>
        {preview.fixtureIds.map((id, i) => {
          const rgb = colors.get(id) ?? [0, 0, 0];
          const base = i * preview.stride;
          const px = pan !== undefined ? (frame[base + pan] ?? 0) / 255 : 0.5;
          const py = tilt !== undefined ? (frame[base + tilt] ?? 0) / 255 : 0.5;
          return (
            <li key={id} className="grid gap-1">
              <span data-testid="preview-swatch" className="h-6 rounded-sm border border-border/60" style={{ backgroundColor: `rgb(${rgb.join(",")})` }} />
              {moves && (
                <span className="relative h-6 rounded-sm bg-background/40">
                  <span className="absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground" style={{ left: `${px * 100}%`, top: `${(1 - py) * 100}%` }} />
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

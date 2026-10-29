import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Dices, Plus, RotateCcw, Unlink, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Segmented } from "@/shared/components/Segmented";
import { randomSeed } from "../lib/curveTiming";
import { MAX_BLOCKS } from "../lib/effectDefSchema";
import {
  effectHasSeed,
  effectName,
  effectParamValue,
  localizedText,
  MAX_WINGS,
  type EffectDef,
  type EffectParamDecl,
  type EffectParams,
  type ParamValue,
} from "../lib/effectLibrary";
import { periodMs } from "../lib/effects";
import type { Rgb } from "../lib/project";
import { useProjectStore } from "../stores/useProjectStore";
import { CommitInput } from "./CommitInput";

/** `#rrggbb` ↔ RGB。 */
const toHex = (rgb: Rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
const fromHex = (hex: string): Rgb | null => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
};

interface EffectParamsPanelProps {
  def: EffectDef;
  params: EffectParams;
  /** 合并修改（`values` 只给出要改的可调参数；值为 `undefined` 的可选字段表示清除） */
  onChange: (patch: Partial<EffectParams>) => void;
  /** 恢复默认参数 */
  onReset: () => void;
  /** 插入面板：“插入”按钮 */
  onInsert?: () => void;
  /** 片段面板：“转为普通外观”按钮 */
  onDetach?: () => void;
  /** 显示特效说明（插入面板） */
  showHint?: boolean;
}

/**
 * 特效参数面板：速度（拍 / 毫秒）、大小、相位扩散、分翼、方向、顺序，特效自己声明的可调参数（数值、百分比、
 * 颜色、色表、选项、开关），以及“高级”里的成块 / 分组 / 打乱 / 按拍对齐 / 换一组随机。
 *
 * 插入前（素材库）与插入后（Cue 属性里的“特效参数”）共用：前者只影响接下来插入的片段，后者重新生成所选片段的外观。
 */
export function EffectParamsPanel({ def, params, onChange, onReset, onInsert, onDetach, showHint = false }: EffectParamsPanelProps) {
  const { t, i18n } = useTranslation();
  const tempo = useProjectStore((s) => s.project.tempo);
  const [advanced, setAdvanced] = useState(false);
  const name = effectName(def, i18n.language);
  const beats = params.period.kind === "beats";
  const periodValue = params.period.kind === "beats" ? params.period.beats : params.period.ms;
  // 大小统一按 0~100% 显示：幅度类 0.5 为满行程
  const sizePct = def.scale === "fraction" ? Math.round(params.size * 200) : Math.round(params.size);
  const num = (text: string) => {
    const v = Number(text);
    return Number.isFinite(v) ? v : null;
  };
  const switchUnit = (unit: "beats" | "ms") => {
    if (unit === params.period.kind) return;
    const ms = periodMs(params.period, tempo);
    const beatMs = periodMs({ kind: "beats", beats: 1 }, tempo);
    onChange({
      period: unit === "ms" ? { kind: "ms", ms: Math.round(ms) } : { kind: "beats", beats: Math.max(0.25, Math.round((ms / beatMs) * 4) / 4) },
    });
  };
  const setValue = (id: string, v: ParamValue) => onChange({ values: { [id]: v } });
  const row = "flex items-center gap-1.5";
  const label = "w-14 shrink-0 text-xs text-muted-foreground";
  const field = "num h-7 w-16 px-2 text-xs";
  const numberField = (labelText: string, value: number, commit: (n: number) => void, unit?: ReactNode) => (
    <div className={row}>
      <span className={label}>{labelText}</span>
      <CommitInput
        className={field}
        inputMode="numeric"
        label={`${name} · ${labelText}`}
        value={value}
        onCommit={(v) => {
          const n = num(v);
          if (n !== null) commit(n);
        }}
      />
      {unit && <span className="text-xs text-muted-foreground">{unit}</span>}
    </div>
  );

  const declControl = (d: EffectParamDecl) => {
    const text = localizedText(d.label, i18n.language) || d.id;
    const value = effectParamValue(def, params, d.id);
    switch (d.type) {
      case "number":
        return numberField(text, typeof value === "number" ? value : d.default, (n) => setValue(d.id, Math.min(d.max, Math.max(d.min, n))), d.unit);
      case "percent":
        return numberField(text, Math.round((typeof value === "number" ? value : d.default) * 100), (n) => setValue(d.id, Math.min(100, Math.max(0, n)) / 100), "%");
      case "color": {
        const rgb = (Array.isArray(value) && value.length === 3 ? value : d.default) as Rgb;
        return (
          <div className={row}>
            <span className={label}>{text}</span>
            <ColorInput label={`${name} · ${text}`} rgb={rgb} onChange={(c) => setValue(d.id, c)} />
          </div>
        );
      }
      case "colors": {
        const list = (Array.isArray(value) && Array.isArray(value[0]) ? value : d.default) as Rgb[];
        const [min, max] = [d.min ?? 1, d.max ?? 16];
        return (
          <div className="flex items-start gap-1.5">
            <span className={`${label} pt-1.5`}>{text}</span>
            <div role="group" aria-label={`${name} · ${text}`} className="flex flex-wrap items-center gap-1">
              {list.map((rgb, i) => (
                <span key={i} className="group/color relative">
                  <ColorInput
                    label={t("editor.effectLib.colorN", { name: text, n: i + 1 })}
                    rgb={rgb}
                    onChange={(c) => setValue(d.id, list.map((x, k) => (k === i ? c : x)))}
                  />
                  {list.length > min && (
                    <button
                      type="button"
                      aria-label={t("editor.effectLib.removeColor", { n: i + 1 })}
                      title={t("editor.effectLib.removeColor", { n: i + 1 })}
                      className="absolute -right-1 -top-1 hidden size-3.5 items-center justify-center rounded-full bg-background text-muted-foreground shadow group-hover/color:flex focus-visible:flex focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => setValue(d.id, list.filter((_, k) => k !== i))}
                    >
                      <X aria-hidden className="size-2.5" />
                    </button>
                  )}
                </span>
              ))}
              {list.length < max && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  aria-label={t("editor.effectLib.addColor", { name: text })}
                  title={t("editor.effectLib.addColor", { name: text })}
                  onClick={() => setValue(d.id, [...list, [...(list.at(-1) ?? [255, 255, 255])] as Rgb])}
                >
                  <Plus aria-hidden className="size-3.5" />
                </Button>
              )}
            </div>
          </div>
        );
      }
      case "choice":
        return (
          <div className={row}>
            <span className={label}>{text}</span>
            <Select value={typeof value === "string" ? value : d.default} onValueChange={(v) => setValue(d.id, v)}>
              <SelectTrigger className="h-7 w-32 text-xs" aria-label={`${name} · ${text}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {d.options.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {localizedText(o.label, i18n.language) || o.value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        );
      case "boolean":
        return (
          <label className={`${row} cursor-pointer text-xs text-muted-foreground`}>
            <Checkbox aria-label={`${name} · ${text}`} checked={value === true} onCheckedChange={(v) => setValue(d.id, v === true)} />
            {text}
          </label>
        );
    }
  };

  return (
    <div role="group" aria-label={t("editor.effectLib.params", { name })} className="grid gap-2 rounded-md border border-primary/40 bg-surface-1 p-2">
      {showHint && <p className="text-xs text-muted-foreground">{localizedText(def.hint, i18n.language)}</p>}
      <div className={row}>
        <span className={label}>{t("editor.effectLib.speed")}</span>
        <CommitInput
          className={field}
          inputMode="numeric"
          label={t("editor.effectLib.speedValue")}
          value={periodValue}
          onCommit={(v) => {
            const n = num(v);
            if (n === null || n <= 0) return;
            onChange({ period: beats ? { kind: "beats", beats: Math.min(64, Math.max(0.125, n)) } : { kind: "ms", ms: Math.min(600_000, Math.max(33, Math.round(n))) } });
          }}
        />
        <Segmented
          size="xs"
          ariaLabel={t("editor.effectLib.speedUnit")}
          value={params.period.kind}
          onChange={switchUnit}
          options={[
            { value: "beats", label: t("editor.effectLib.beats") },
            { value: "ms", label: t("editor.effectLib.ms") },
          ]}
        />
      </div>
      <div className={row}>
        <span className={label}>{t("editor.effectLib.size")}</span>
        <CommitInput
          className={field}
          inputMode="numeric"
          label={t("editor.effectLib.sizeValue")}
          value={sizePct}
          onCommit={(v) => {
            const n = num(v);
            if (n === null) return;
            const pct = Math.min(100, Math.max(0, n));
            onChange({ size: def.scale === "fraction" ? pct / 200 : pct });
          }}
        />
        <span className="text-xs text-muted-foreground">%</span>
      </div>
      {(def.params ?? []).map((d) => (
        <div key={d.id}>{declControl(d)}</div>
      ))}
      <div className={row}>
        <span className={label}>{t("editor.effectLib.spread")}</span>
        <CommitInput
          className={field}
          inputMode="numeric"
          label={t("editor.effectLib.spreadValue")}
          value={Math.round(params.spread * 100)}
          onCommit={(v) => {
            const n = num(v);
            if (n !== null) onChange({ spread: Math.min(400, Math.max(0, n)) / 100 });
          }}
        />
        <span className="text-xs text-muted-foreground">%</span>
      </div>
      <div className={row}>
        <span className={label}>{t("editor.effectLib.wings")}</span>
        <Segmented
          size="xs"
          ariaLabel={t("editor.effectLib.wings")}
          value={String(params.wings)}
          onChange={(v) => onChange({ wings: Number(v) })}
          options={Array.from({ length: MAX_WINGS }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))}
        />
      </div>
      <div className={row}>
        <span className={label}>{t("editor.effectLib.direction")}</span>
        <Segmented
          size="xs"
          ariaLabel={t("editor.effectLib.direction")}
          value={params.direction > 0 ? "forward" : "reverse"}
          onChange={(v) => onChange({ direction: v === "forward" ? 1 : -1 })}
          options={[
            { value: "forward", label: t("editor.effectLib.forward") },
            { value: "reverse", label: t("editor.effectLib.reverse") },
          ]}
        />
      </div>
      <div className={row}>
        <span className={label}>{t("editor.effectLib.order")}</span>
        <Segmented
          size="xs"
          ariaLabel={t("editor.effectLib.order")}
          value={params.order}
          onChange={(v) => onChange({ order: v })}
          options={[
            { value: "members", label: t("editor.effectLib.orders.members") },
            { value: "stageX", label: t("editor.effectLib.orders.stageX") },
            { value: "stageY", label: t("editor.effectLib.orders.stageY") },
          ]}
        />
      </div>

      <button
        type="button"
        aria-expanded={advanced}
        onClick={() => setAdvanced(!advanced)}
        className="flex items-center gap-1 rounded-sm text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {advanced ? <ChevronDown aria-hidden className="size-3.5" /> : <ChevronRight aria-hidden className="size-3.5" />}
        {t("editor.effectLib.advanced")}
      </button>
      {advanced && (
        <div className="grid gap-2 border-l border-border pl-2">
          {numberField(t("editor.effectLib.blocks"), params.blocks ?? 1, (n) => onChange({ blocks: clampCount(n) > 1 ? clampCount(n) : undefined }))}
          {numberField(t("editor.effectLib.groupEvery"), params.groups ?? 1, (n) => onChange({ groups: clampCount(n) > 1 ? clampCount(n) : undefined }))}
          <div className={`${row} flex-wrap`}>
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground" title={t("editor.effectLib.shuffleHint")}>
              <Checkbox
                aria-label={`${name} · ${t("editor.effectLib.shuffle")}`}
                checked={params.shuffle !== undefined}
                onCheckedChange={(v) => onChange({ shuffle: v === true ? randomSeed() : undefined })}
              />
              {t("editor.effectLib.shuffle")}
            </label>
            {params.shuffle !== undefined && (
              <Button type="button" variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-xs" onClick={() => onChange({ shuffle: randomSeed() })}>
                <Dices aria-hidden className="size-3.5" />
                {t("editor.effectLib.reshuffle")}
              </Button>
            )}
          </div>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground" title={t("editor.curve.syncHint")}>
            <Checkbox
              aria-label={`${name} · ${t("editor.curve.sync")}`}
              checked={params.sync === true}
              onCheckedChange={(v) => onChange({ sync: v === true ? true : undefined })}
            />
            {t("editor.curve.sync")}
          </label>
          {effectHasSeed(def) && (
            <Button type="button" variant="outline" size="sm" className="h-7 justify-self-start gap-1 px-2 text-xs" onClick={() => onChange({ seed: randomSeed() })}>
              <Dices aria-hidden className="size-3.5" />
              {t("editor.curve.reseed")}
            </Button>
          )}
        </div>
      )}

      <div className="flex items-center justify-between gap-2 pt-0.5">
        <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={onReset}>
          <RotateCcw aria-hidden />
          {t("editor.effectLib.reset")}
        </Button>
        {onInsert && (
          <Button type="button" size="sm" className="h-7 gap-1 px-3 text-xs" onClick={onInsert}>
            <Plus aria-hidden />
            {t("editor.effectLib.insertSelected")}
          </Button>
        )}
        {onDetach && (
          <Button type="button" variant="outline" size="sm" className="h-7 gap-1 px-2 text-xs" title={t("editor.fx.detachHint")} onClick={onDetach}>
            <Unlink aria-hidden />
            {t("editor.fx.detach")}
          </Button>
        )}
      </div>
    </div>
  );
}

/** 成块 / 分组的台数。 */
function clampCount(n: number): number {
  return Math.min(MAX_BLOCKS, Math.max(1, Math.round(n)));
}

/**
 * 一个颜色输入（系统取色器），显示为色块。拖动取色时只改本地草稿，失去焦点时提交一次（一步撤销）。
 */
function ColorInput({ label, rgb, onChange }: { label: string; rgb: Rgb; onChange: (rgb: Rgb) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    const c = draft !== null ? fromHex(draft) : null;
    setDraft(null);
    if (c && toHex(c) !== toHex(rgb)) onChange(c);
  };
  return (
    <input
      type="color"
      aria-label={label}
      title={label}
      value={draft ?? toHex(rgb)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
      className="h-6 w-8 cursor-pointer rounded-sm border border-border bg-transparent p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    />
  );
}

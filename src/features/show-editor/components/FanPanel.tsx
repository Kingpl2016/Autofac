import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeftRight, Spline } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Segmented } from "@/shared/components/Segmented";
import { announce } from "@/shared/stores/announcerStore";
import { availableAttrsOf, colorModes } from "../lib/fixtureProfile";
import {
  FAN_MODES,
  FAN_TRANSITIONS,
  fanValues,
  programFan,
  type FanLayer,
  type FanMode,
  type FanTransition,
  type ProgrammerValues,
} from "../lib/programmer";
import type { Look, ShowProject } from "../lib/project";
import { CommitInput } from "./CommitInput";

interface FanPanelProps {
  project: Pick<ShowProject, "fixtures" | "fixtureModels">;
  /** 选中的灯具或像素引用（选择顺序：分布按这个顺序） */
  order: readonly string[];
  values: ProgrammerValues;
  /**
   * 写回编程器内容。
   *
   * @param next 新内容。
   */
  onChange: (next: Record<string, Look>) => void;
}

/** 各层的取值范围、单位与默认起止值。 */
function rangeOf(layer: FanLayer): { min: number; max: number; unit: string; from: number; to: number } {
  if (layer === "intensity") return { min: 0, max: 100, unit: "%", from: 0, to: 100 };
  if (layer === "hue") return { min: 0, max: 360, unit: "°", from: 0, to: 300 };
  return { min: 0, max: 100, unit: "%", from: 0, to: 100 };
}

/**
 * 编程器的分布（grandMA3 的 Align / Fan）：把强度、色相或某个属性按选择顺序从 A 分布到 B。
 *
 * 五种方式：`/` 中间为轴对称展开、`<` 从第一台起、`>` 从最后一台起、`><` 中间最大、`<>` 两端最大；
 * 四种过渡：等距、正弦、先慢后快、先快后慢。面板下方实时画出每台灯的取值。
 */
export function FanPanel({ project, order, values, onChange }: FanPanelProps) {
  const { t } = useTranslation();
  const attrs = useMemo(() => availableAttrsOf(project, order), [project, order]);
  const canColor = useMemo(() => colorModes(project, order).includes("rgb"), [project, order]);
  const layers: FanLayer[] = ["intensity", ...(canColor ? (["hue"] as const) : []), ...attrs.map((a) => a.key)];
  const [layerRaw, setLayer] = useState<FanLayer>("intensity");
  const layer = layers.includes(layerRaw) ? layerRaw : "intensity";
  const range = rangeOf(layer);
  const [ends, setEnds] = useState<Partial<Record<FanLayer, [number, number]>>>({});
  const [from, to] = ends[layer] ?? [range.from, range.to];
  const [mode, setMode] = useState<FanMode>(">");
  const [transition, setTransition] = useState<FanTransition>("linear");

  const labelOf = (l: FanLayer) => (l === "intensity" ? t("editor.programmer.intensity") : l === "hue" ? t("editor.fan.hue") : t(`fixtures.functions.${l}`));
  const preview = fanValues(order.length, from, to, mode, transition).map((v) => Math.min(range.max, Math.max(range.min, v)));
  const supports = (id: string) => availableAttrsOf(project, [id]).some((a) => a.key === layer);
  const scale = (v: number) => (layer === "intensity" || layer === "hue" ? v : v / 100);

  const setEnd = (which: 0 | 1, text: string) => {
    const n = Number(text);
    if (!Number.isFinite(n)) return;
    const v = Math.min(range.max, Math.max(range.min, n));
    const next: [number, number] = which === 0 ? [v, to] : [from, v];
    setEnds((prev) => ({ ...prev, [layer]: next }));
  };

  const apply = () => {
    onChange(programFan(values, order, layer, scale(from), scale(to), mode, transition, supports));
    announce(t("editor.fan.applied", { name: labelOf(layer), count: order.length }));
  };

  if (order.length < 2) return <p className="text-xs text-muted-foreground">{t("editor.fan.needTwo")}</p>;

  return (
    <div className="grid gap-2">
      <Select value={layer} onValueChange={(v) => setLayer(v as FanLayer)}>
        <SelectTrigger className="h-7 text-xs" aria-label={t("editor.fan.layer")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {layers.map((l) => (
            <SelectItem key={l} value={l}>
              {labelOf(l)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="flex items-end gap-1.5">
        <label className="grid flex-1 gap-0.5 text-[11px] text-muted-foreground">
          {t("editor.fan.from")}
          <CommitInput className="num h-7 px-1.5 text-xs" inputMode="numeric" label={t("editor.fan.from")} value={from} onCommit={(s) => setEnd(0, s)} />
        </label>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={t("editor.fan.swap")}
          title={t("editor.fan.swap")}
          onClick={() => setEnds((prev) => ({ ...prev, [layer]: [to, from] }))}
        >
          <ArrowLeftRight aria-hidden />
        </Button>
        <label className="grid flex-1 gap-0.5 text-[11px] text-muted-foreground">
          {t("editor.fan.to")}
          <CommitInput className="num h-7 px-1.5 text-xs" inputMode="numeric" label={t("editor.fan.to")} value={to} onCommit={(s) => setEnd(1, s)} />
        </label>
        <span className="pb-1.5 text-[11px] text-muted-foreground">{range.unit}</span>
      </div>
      <Segmented<FanMode>
        size="xs"
        ariaLabel={t("editor.fan.mode")}
        value={mode}
        options={FAN_MODES.map((m) => ({ value: m, label: m, title: t(`editor.fan.modes.${modeKey(m)}`) }))}
        onChange={setMode}
      />
      <Segmented<FanTransition>
        size="xs"
        ariaLabel={t("editor.fan.transition")}
        value={transition}
        options={FAN_TRANSITIONS.map((m) => ({ value: m, label: t(`editor.fan.transitions.${m}`) }))}
        onChange={setTransition}
      />
      {/* 预览：每台灯一根柱子（按选择顺序） */}
      <div role="img" aria-label={t("editor.fan.preview", { values: preview.map((v) => Math.round(v)).join("、") })} className="flex h-10 items-end gap-px rounded-md border border-border p-1">
        {preview.map((v, i) => (
          <span
            key={i}
            className="min-w-0 flex-1 rounded-t-[1px] bg-primary/70"
            style={{ height: `${Math.max(4, ((v - range.min) / (range.max - range.min)) * 100)}%` }}
          />
        ))}
      </div>
      <Button type="button" size="sm" className="h-8" onClick={apply}>
        <Spline aria-hidden />
        {t("editor.fan.apply", { count: order.length })}
      </Button>
    </div>
  );
}

/**
 * 分布方式在语言包里的键（符号不能直接做键）。
 *
 * @param m 分布方式。
 * @returns 键名。
 */
function modeKey(m: FanMode): string {
  return { "/": "center", "<": "first", ">": "last", "><": "middle", "<>": "ends" }[m];
}

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { emitterFunctions } from "../../lib/draft";
import { applyEmitterPreset, TYPICAL_LED } from "../../lib/emitterPresets";
import { inferShape } from "../../lib/shape";
import { AppearanceAssets } from "./AppearanceAssets";
import {
  FIXTURE_SHAPES,
  FOCUS_TYPES,
  type ChannelFunction,
  type Emitter,
  type FixtureModel,
  type FixtureShape,
  type FocusType,
  type Physical,
} from "../../lib/types";

interface ModelExtrasProps {
  draft: FixtureModel;
  onChange: (changes: Partial<FixtureModel>) => void;
}

/** 可选正数输入：空串表示“未设置”。 */
function optionalNumber(raw: string): number | undefined {
  if (raw.trim() === "") return undefined;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

/** 去掉值为 `undefined` 的字段；全部为空时返回 `undefined`（序列化时省略整个对象）。 */
function compact<T extends object>(obj: T): T | undefined {
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined);
  return entries.length === 0 ? undefined : (Object.fromEntries(entries) as T);
}

/** 白光类发光体按色温校准，其余按颜色校准。 */
const KELVIN_EMITTERS: ReadonlySet<ChannelFunction> = new Set<ChannelFunction>(["white", "coolWhite", "warmWhite"]);

/**
 * 像素排布与物理参数：多头灯的行列数、Pan / Tilt 行程、光束角。
 * 舞台预览据此计算光束落点和光锥大小；不填时按通用摇头灯处理。
 */
export function PhysicalSection({ draft, onChange }: ModelExtrasProps) {
  const { t } = useTranslation();
  const physical = draft.physical ?? {};
  const setPhysical = (changes: Partial<Physical>) => onChange({ physical: compact({ ...physical, ...changes }) });
  const matrix = draft.matrix;
  // 尺寸只填了一部分时先留在本地（模型里只存完整的宽高深）
  const [partialDims, setPartialDims] = useState<(number | undefined)[] | null>(null);
  const numberField = (id: string, label: string, value: number | undefined, set: (v: number | undefined) => void, pending?: number) => (
    <div key={id} className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        className="num"
        inputMode="decimal"
        value={value ?? pending ?? ""}
        onChange={(e) => set(optionalNumber(e.target.value))}
      />
    </div>
  );

  return (
    <div className="grid gap-5">
      <fieldset className="grid gap-3">
        <legend className="mb-1 text-sm font-medium">{t("fixtures.editor.matrix")}</legend>
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={matrix !== undefined}
            onCheckedChange={(v) => onChange({ matrix: v ? { cols: 4, rows: 1 } : undefined })}
          />
          {t("fixtures.editor.matrixEnable")}
        </label>
        {matrix && (
          <div className="grid max-w-md grid-cols-2 gap-3">
            {numberField("fx-cols", t("fixtures.editor.matrixCols"), matrix.cols, (v) =>
              onChange({ matrix: { ...matrix, cols: Math.floor(v ?? 0) } }),
            )}
            {numberField("fx-rows", t("fixtures.editor.matrixRows"), matrix.rows, (v) =>
              onChange({ matrix: { ...matrix, rows: Math.floor(v ?? 0) } }),
            )}
            <p className="col-span-2 text-xs text-muted-foreground">
              {t("fixtures.editor.matrixHint", { count: matrix.cols * matrix.rows })}
            </p>
          </div>
        )}
      </fieldset>
      <fieldset className="grid gap-3">
        <legend className="mb-1 text-sm font-medium">{t("fixtures.editor.physical")}</legend>
        <div className="grid gap-3 sm:grid-cols-4">
          {numberField("fx-pan", t("fixtures.editor.panRange"), physical.panRangeDeg, (v) => setPhysical({ panRangeDeg: v }))}
          {numberField("fx-tilt", t("fixtures.editor.tiltRange"), physical.tiltRangeDeg, (v) => setPhysical({ tiltRangeDeg: v }))}
          {numberField("fx-beam-min", t("fixtures.editor.beamMin"), physical.beamMinDeg, (v) => setPhysical({ beamMinDeg: v }))}
          {numberField("fx-beam-max", t("fixtures.editor.beamMax"), physical.beamMaxDeg, (v) => setPhysical({ beamMaxDeg: v }))}
        </div>
        <div className="grid gap-3 sm:grid-cols-5">
          {(["width", "height", "depth"] as const).map((axis, i) =>
            numberField(`fx-dim-${axis}`, t(`fixtures.editor.dim.${axis}`), physical.dimensionsMm?.[i], (v) => {
              const dims: (number | undefined)[] = [...(physical.dimensionsMm ?? [undefined, undefined, undefined])];
              dims[i] = v;
              // 三个尺寸都填了才保存（后端要求完整的宽高深）
              const full = dims.every((d) => d !== undefined) ? (dims as [number, number, number]) : undefined;
              setPhysical({ dimensionsMm: full });
              setPartialDims(full ? null : dims);
            }, partialDims?.[i]),
          )}
          {numberField("fx-weight", t("fixtures.editor.weight"), physical.weightKg, (v) => setPhysical({ weightKg: v }))}
          {numberField("fx-power", t("fixtures.editor.power"), physical.powerW, (v) => setPhysical({ powerW: v }))}
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <div className="grid gap-1.5">
            <Label htmlFor="fx-lens">{t("fixtures.editor.lensName")}</Label>
            <Input
              id="fx-lens"
              maxLength={64}
              value={physical.lensName ?? ""}
              onChange={(e) => setPhysical({ lensName: e.target.value.trim() === "" ? undefined : e.target.value })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="fx-focus">{t("fixtures.editor.focusType")}</Label>
            <Select value={physical.focusType ?? NONE} onValueChange={(v) => setPhysical({ focusType: v === NONE ? undefined : (v as FocusType) })}>
              <SelectTrigger id="fx-focus">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{t("fixtures.editor.unset")}</SelectItem>
                {FOCUS_TYPES.map((f) => (
                  <SelectItem key={f} value={f}>
                    {t(`fixtures.focus.${f}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </fieldset>
      <fieldset className="grid gap-3">
        <legend className="mb-1 text-sm font-medium">{t("fixtures.editor.appearance")}</legend>
        <div className="grid max-w-md gap-1.5">
          <Label htmlFor="fx-shape">{t("fixtures.editor.shape")}</Label>
          <Select
            value={draft.appearance?.shape ?? NONE}
            onValueChange={(v) =>
              onChange({
                appearance: v === NONE && !draft.appearance?.icon && !draft.appearance?.model3d
                  ? undefined
                  : { ...draft.appearance, shape: v === NONE ? inferShape(draft) : (v as FixtureShape), origin: "user" },
              })
            }
          >
            <SelectTrigger id="fx-shape">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>{t("fixtures.editor.shapeAuto", { shape: t(`fixtures.shape.${inferShape(draft)}`) })}</SelectItem>
              {FIXTURE_SHAPES.map((s) => (
                <SelectItem key={s} value={s}>
                  {t(`fixtures.shape.${s}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t("fixtures.editor.shapeHint")}</p>
        </div>
        <AppearanceAssets draft={draft} onChange={onChange} />
      </fieldset>
    </div>
  );
}

/** 下拉框里“未设置”的取值。 */
const NONE = "__none";

const toHex = (c: [number, number, number] | undefined) =>
  c ? `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}` : "#ffffff";
const fromHex = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16) || 0,
  parseInt(hex.slice(3, 5), 16) || 0,
  parseInt(hex.slice(5, 7), 16) || 0,
];

/**
 * 发光体校准：按灯具实际 LED 的色温 / 颜色与相对亮度修正混色。
 * 未校准的发光体按理想颜色计算（白光 6500K、暖白 3000K、冷白 6500K）。
 */
export function EmitterSection({ draft, onChange }: ModelExtrasProps) {
  const { t } = useTranslation();
  const functions = emitterFunctions(draft);
  const emitters = draft.emitters ?? [];
  const find = (fn: ChannelFunction) => emitters.find((e) => e.function === fn);
  const set = (fn: ChannelFunction, changes: Partial<Emitter>) => {
    const current: Emitter = find(fn) ?? { function: fn };
    const next = compact({ ...current, ...changes }) as Emitter;
    const others = emitters.filter((e) => e.function !== fn);
    const meaningful = next.rgb !== undefined || next.kelvin !== undefined || next.intensity !== undefined;
    const list = meaningful ? [...others, next] : others;
    onChange({ emitters: list.length > 0 ? list : undefined });
  };

  if (functions.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("fixtures.editor.noEmitters")}</p>;
  }
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">{t("fixtures.editor.emittersHint")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          title={t("fixtures.editor.typicalLedHint")}
          onClick={() => onChange({ emitters: applyEmitterPreset(functions, draft.emitters, TYPICAL_LED) })}
        >
          {t("fixtures.editor.typicalLed")}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={emitters.length === 0} onClick={() => onChange({ emitters: undefined })}>
          {t("fixtures.editor.clearEmitters")}
        </Button>
      </div>
      <table className="w-full max-w-2xl text-sm">
        <caption className="sr-only">{t("fixtures.editor.emitters")}</caption>
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th scope="col" className="pb-2 pr-3 font-medium">{t("fixtures.table.function")}</th>
            <th scope="col" className="pb-2 pr-3 font-medium">{t("fixtures.editor.emitterCalibration")}</th>
            <th scope="col" className="pb-2 font-medium">{t("fixtures.editor.emitterIntensity")}</th>
          </tr>
        </thead>
        <tbody>
          {functions.map((fn) => {
            const e = find(fn);
            const name = t(`fixtures.functions.${fn}`);
            return (
              <tr key={fn}>
                <th scope="row" className="py-1.5 pr-3 text-left font-medium">{name}</th>
                <td className="py-1.5 pr-3">
                  {KELVIN_EMITTERS.has(fn) ? (
                    <span className="flex items-center gap-1.5">
                      <Input
                        className="num h-9 w-28 px-2"
                        inputMode="numeric"
                        aria-label={t("fixtures.editor.emitterKelvin", { name })}
                        placeholder={fn === "warmWhite" ? "3000" : "6500"}
                        value={e?.kelvin ?? ""}
                        onChange={(ev) => {
                          const v = optionalNumber(ev.target.value);
                          set(fn, { kelvin: v === undefined ? undefined : Math.round(v) });
                        }}
                      />
                      <span className="text-muted-foreground">K</span>
                    </span>
                  ) : (
                    <input
                      type="color"
                      className="h-9 w-14 cursor-pointer rounded-md border border-border bg-transparent"
                      aria-label={t("fixtures.editor.emitterColor", { name })}
                      value={toHex(e?.rgb)}
                      onChange={(ev) => set(fn, { rgb: fromHex(ev.target.value) })}
                    />
                  )}
                </td>
                <td className="py-1.5">
                  <Input
                    className="num h-9 w-24 px-2"
                    inputMode="decimal"
                    aria-label={t("fixtures.editor.emitterIntensityOf", { name })}
                    placeholder="1"
                    value={e?.intensity ?? ""}
                    onChange={(ev) => set(fn, { intensity: optionalNumber(ev.target.value) })}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

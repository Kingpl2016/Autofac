import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { Pipette } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Segmented } from "@/shared/components/Segmented";
import { isEmitter, layoutOf, type FixtureModel } from "@/features/fixtures";
import { useEngine } from "../engine/useEngine";
import { hexToRgb, hsToWheel, hsvToRgb, rgbToHex, rgbToHsv, wheelToHs, type Hsv } from "../lib/colorMath";
import { colorValueRgb, kelvinToRgb } from "../lib/looks";
import { mixPreview } from "../lib/mixPreview";
import type { ColorValue, EmitterKey, Rgb, WhiteStrategy } from "../lib/project";
import { clamp } from "../lib/time";
import { COLOR_INPUTS, useColorInputStore, type ColorInput } from "../stores/useColorInputStore";
import { useRecentColorsStore } from "../stores/useRecentColorsStore";
import { CommitInput } from "./CommitInput";

/** 色盘模式。 */
type Mode = "rgb" | "kelvin" | "manual";

/** 色温范围。 */
const MIN_K = 1800;
const MAX_K = 10_000;
/** 常用色温。 */
const KELVIN_PRESETS = [2700, 3200, 4300, 5600, 6500] as const;

/** 常用色（剧场色纸的近似 + 常用白光）。 */
const PALETTE: { id: string; color: ColorValue }[] = [
  { id: "red", color: { kind: "rgb", rgb: [255, 0, 0] } },
  { id: "orange", color: { kind: "rgb", rgb: [255, 96, 0] } },
  { id: "amber", color: { kind: "rgb", rgb: [255, 170, 0] } },
  { id: "yellow", color: { kind: "rgb", rgb: [255, 230, 0] } },
  { id: "lime", color: { kind: "rgb", rgb: [160, 255, 0] } },
  { id: "green", color: { kind: "rgb", rgb: [0, 255, 40] } },
  { id: "cyan", color: { kind: "rgb", rgb: [0, 255, 220] } },
  { id: "sky", color: { kind: "rgb", rgb: [60, 160, 255] } },
  { id: "blue", color: { kind: "rgb", rgb: [0, 30, 255] } },
  { id: "congo", color: { kind: "rgb", rgb: [90, 0, 255] } },
  { id: "magenta", color: { kind: "rgb", rgb: [255, 0, 200] } },
  { id: "pink", color: { kind: "rgb", rgb: [255, 110, 160] } },
  { id: "warm", color: { kind: "kelvin", kelvin: 3200 } },
  { id: "neutral", color: { kind: "kelvin", kelvin: 4300 } },
  { id: "daylight", color: { kind: "kelvin", kelvin: 5600 } },
  { id: "white", color: { kind: "rgb", rgb: [255, 255, 255] } },
];

/** 色轮背景：色相一圈（0 度在正上方，顺时针）+ 中心向外由白到饱和。 */
const WHEEL_BACKGROUND = [
  "radial-gradient(circle closest-side, hsl(0 0% 100%), hsl(0 0% 100% / 0))",
  `conic-gradient(${[0, 60, 120, 180, 240, 300, 360].map((h) => `hsl(${h} 100% 50%)`).join(", ")})`,
].join(", ");

/** 色温滑杆背景。 */
const KELVIN_BACKGROUND = `linear-gradient(to right, ${[1800, 2700, 3200, 4300, 5600, 6500, 8000, 10000]
  .map((k) => {
    const [r, g, b] = kelvinToRgb(k);
    return `rgb(${r} ${g} ${b}) ${(((k - MIN_K) / (MAX_K - MIN_K)) * 100).toFixed(1)}%`;
  })
  .join(", ")})`;

/** 颜色明度（HSV 的 V）滑杆：黑 → 当前色相与饱和度下的满明度。 */
const valueGradient = ({ h, s }: Hsv) => {
  const [r, g, b] = hsvToRgb({ h, s, v: 1 });
  return `linear-gradient(to right, rgb(0 0 0), rgb(${r} ${g} ${b}))`;
};
/** RGB 某一通道的滑杆：其它通道不变，该通道 0 → 255。 */
const channelGradient = (rgb: Rgb, i: number) => {
  const at = (v: number) => {
    const c: Rgb = [...rgb];
    c[i] = v;
    return `rgb(${c[0]} ${c[1]} ${c[2]})`;
  };
  return `linear-gradient(to right, ${at(0)}, ${at(255)})`;
};

/** 只做颜色显示的 `rgb()`。 */
const css = ([r, g, b]: Rgb) => `rgb(${r} ${g} ${b})`;

/** 颜色值是否相同（比较用）。 */
const same = (a: ColorValue, b: ColorValue) => JSON.stringify(a) === JSON.stringify(b);

interface ColorPickerProps {
  /** 当前颜色（缺省为白光） */
  value: ColorValue | undefined;
  /**
   * 提交：松开指针、键盘调整结束、输入框提交或点色板时调用一次。
   *
   * @param value 新颜色。
   */
  onCommit: (value: ColorValue) => void;
  /** 目标灯具的模型与模式：用于发光体推子和“实际输出”预览；省略时只显示意图色 */
  target?: { model: FixtureModel; modeId?: string } | null;
  /** 工程 Gamma（实际输出预览用） */
  gamma?: number;
}

/**
 * 专业色盘：
 *
 * - **彩色**：选一个目标颜色，由每台灯的混色器按它的发光体自动混出。两种输入方式（记住上次的选择）——
 *   色轮（HSV：色相 + 饱和度，旁边直接显示 / 输入 H、S、V，V 为颜色明度）与 RGB 数值滑杆；
 *   都可输入十六进制；白光策略决定 RGBW / RGBCW 灯怎样用白光。整体亮度由外观的强度层负责；
 * - **色温**：1800K~10000K 滑杆与常用色温（RGB 灯按色温近似，冷暖白灯按 mired 分配）；
 * - **发光体**：按目标灯具的发光体逐路直给（手动覆盖混色）；
 * - 常用色、最近使用、屏幕取色；
 * - **实际输出**：用引擎模拟目标灯具真正发出的颜色和各发光体的输出。
 *
 * 拖动时只改本地草稿（实时显示），松手才提交，一次拖动一步撤销。
 */
export function ColorPicker({ value, onCommit, target, gamma = 2.2 }: ColorPickerProps) {
  const { t } = useTranslation();
  const engine = useEngine();
  const recent = useRecentColorsStore((s) => s.colors);
  const pushRecent = useRecentColorsStore((s) => s.push);
  const current: ColorValue = value ?? { kind: "rgb", rgb: [255, 255, 255] };
  const [draft, setDraft] = useState<ColorValue | null>(null);
  const shown = draft ?? current;
  const wheelRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const commit = (next: ColorValue) => {
    setDraft(null);
    if (!same(next, current)) onCommit(next);
    pushRecent(next);
  };

  // 松开指针可能发生在控件之外：在窗口上监听
  useEffect(() => {
    if (draft === null) return;
    const finish = () => {
      if (!dragging.current) return;
      dragging.current = false;
      commit(draft);
    };
    window.addEventListener("pointerup", finish);
    return () => window.removeEventListener("pointerup", finish);
  });

  // 模式就是当前颜色值的类型：切换模式会提交一个换算后的颜色
  const mode: Mode = shown.kind;
  const rgb = colorValueRgb(shown);
  const white: WhiteStrategy = shown.kind === "rgb" ? (shown.white ?? "preserve") : "preserve";
  const asRgb = (next: Rgb): ColorValue => ({ kind: "rgb", rgb: next, ...(white !== "preserve" ? { white } : {}) });

  // ---- 输入方式（色轮 HSV / RGB 数值，记住上次的选择） ----
  const input = useColorInputStore((s) => s.input);
  const setInput = useColorInputStore((s) => s.setInput);
  // 饱和度或明度到 0 时 RGB 里没有色相：保留上次的 HSV，颜色没被外部改动时继续用它（拉回来颜色不变）
  const [hsvHold, setHsvHold] = useState<Hsv | null>(null);
  const hsv: Hsv = hsvHold && same(asRgb(hsvToRgb(hsvHold)), shown) ? hsvHold : rgbToHsv(shown.kind === "rgb" ? shown.rgb : rgb);
  const fromHsv = (next: Hsv): ColorValue => {
    const held = { h: ((next.h % 360) + 360) % 360, s: clamp(next.s, 0, 1), v: clamp(next.v, 0, 1) };
    setHsvHold(held);
    return asRgb(hsvToRgb(held));
  };

  // ---- 目标灯具的发光体 ----
  const emitters = (() => {
    const layout = target ? (layoutOf(target.model, target.modeId) ?? []) : [];
    const list = layout.filter((p) => isEmitter(p.function) && (p.head ?? 0) === 0);
    const seen = new Set<string>();
    return list.filter((p) => (seen.has(p.function) ? false : (seen.add(p.function), true)));
  })();
  const output = target ? mixPreview(engine, target.model, target.modeId, shown, gamma) : null;

  // ---- 色轮 ----
  const fromPointer = (e: PointerEvent<HTMLDivElement>) => {
    const r = wheelRef.current?.getBoundingClientRect();
    if (!r || r.width === 0) return;
    const { h, s } = wheelToHs(((e.clientX - r.left) / r.width) * 2 - 1, ((e.clientY - r.top) / r.height) * 2 - 1);
    setDraft(fromHsv({ h, s, v: hsv.v > 0 ? hsv.v : 1 }));
  };
  const onWheelKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 15 : 5;
    let { h, s } = hsv;
    if (e.key === "ArrowLeft") h = (h - step + 360) % 360;
    else if (e.key === "ArrowRight") h = (h + step) % 360;
    else if (e.key === "ArrowUp") s = clamp(s + step / 100, 0, 1);
    else if (e.key === "ArrowDown") s = clamp(s - step / 100, 0, 1);
    else return;
    e.preventDefault();
    commit(fromHsv({ h, s, v: hsv.v > 0 ? hsv.v : 1 }));
  };
  const dot = hsToWheel(hsv.h, hsv.s);

  const switchMode = (next: Mode) => {
    if (next === shown.kind) return;
    if (next === "rgb") commit({ kind: "rgb", rgb });
    else if (next === "kelvin") commit({ kind: "kelvin", kelvin: 3200 });
    else {
      const values: Partial<Record<EmitterKey, number>> = {};
      for (const lv of output?.emitters ?? []) values[lv.fn as EmitterKey] = Math.round(lv.level * 100) / 100;
      commit({ kind: "manual", values });
    }
  };

  const numberField = (label: string, v: number, onValue: (n: number) => void, width = "w-14") => (
    <label className="grid gap-0.5 text-[11px] text-muted-foreground">
      {label}
      <CommitInput
        className={cn("num h-7 px-1.5 text-xs", width)}
        inputMode="numeric"
        label={label}
        value={v}
        onCommit={(text) => {
          const n = Number(text);
          if (Number.isFinite(n)) onValue(n);
        }}
      />
    </label>
  );

  const swatch = (id: string, color: ColorValue, label: string) => (
    <button
      key={id}
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={same(color, shown)}
      onClick={() => {
        commit(color);
      }}
      className={cn(
        "size-6 cursor-pointer rounded-sm border border-border bg-(--sw) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        same(color, shown) && "ring-2 ring-primary",
      )}
      style={{ "--sw": css(colorValueRgb(color)) } as CSSProperties}
    />
  );

  /** 带渐变底色的滑杆 + 数值框：拖动只改草稿，松手 / 回车提交。 */
  const gradientSlider = (
    label: string,
    short: string,
    value: number,
    min: number,
    max: number,
    unit: string,
    background: string,
    toColor: (v: number) => ColorValue,
  ) => (
    <div key={short} className="grid grid-cols-[1rem_1fr_3.5rem] items-center gap-2">
      <span aria-hidden className="text-[11px] text-muted-foreground">
        {short}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        aria-label={label}
        aria-valuetext={`${value}${unit}`}
        className="h-3 w-full cursor-pointer appearance-none rounded-full border border-border accent-foreground"
        style={{ background }}
        onChange={(e) => {
          dragging.current = true;
          setDraft(toColor(Number(e.target.value)));
        }}
        onKeyUp={() => draft && commit(draft)}
      />
      <CommitInput
        className="num h-7 px-1.5 text-xs"
        inputMode="numeric"
        label={t("editor.color.valueOf", { name: label })}
        value={value}
        onCommit={(text) => {
          const n = Number(text);
          if (Number.isFinite(n)) commit(toColor(clamp(n, min, max)));
        }}
      />
    </div>
  );

  const hexField = (
    <label className="grid gap-0.5 text-[11px] text-muted-foreground">
      {t("editor.color.hex")}
      <CommitInput
        className="num h-7 px-1.5 text-xs"
        label={t("editor.color.hex")}
        value={rgbToHex(rgb)}
        onCommit={(text) => {
          const parsed = hexToRgb(text);
          if (parsed) commit(asRgb(parsed));
        }}
      />
    </label>
  );

  const EyeDropperCtor = typeof window !== "undefined" ? (window as unknown as { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper : undefined;

  return (
    <section aria-label={t("editor.color.title")} className="grid gap-3">
      <div className="flex items-center justify-between gap-2">
        <Segmented<Mode>
          ariaLabel={t("editor.color.mode")}
          value={mode}
          options={(["rgb", "kelvin", "manual"] as const).map((m) => ({
            value: m,
            label: t(`editor.color.modes.${m}`),
            title: t(`editor.color.modeHints.${m}`),
          }))}
          onChange={switchMode}
        />
        <span
          role="img"
          aria-label={t("editor.color.intent", { hex: rgbToHex(rgb) })}
          className="size-7 rounded-md border border-border bg-(--intent)"
          style={{ "--intent": css(rgb) } as CSSProperties}
        />
      </div>

      {mode === "rgb" && shown.kind === "rgb" && (
        <div data-tour="color-input" className="grid gap-2">
          <Segmented<ColorInput>
            ariaLabel={t("editor.color.input")}
            value={input}
            options={COLOR_INPUTS.map((m) => ({ value: m, label: t(`editor.color.inputs.${m}`) }))}
            onChange={setInput}
          />
          {input === "wheel" ? (
          <div className="flex items-start gap-3">
            <div
              ref={wheelRef}
              role="slider"
              tabIndex={0}
              aria-label={t("editor.color.wheel")}
              aria-valuemin={0}
              aria-valuemax={360}
              aria-valuenow={Math.round(hsv.h)}
              aria-valuetext={t("editor.color.wheelValue", { h: Math.round(hsv.h), s: Math.round(hsv.s * 100) })}
              className="relative size-40 shrink-0 cursor-crosshair touch-none rounded-full border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              style={{ background: WHEEL_BACKGROUND }}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture?.(e.pointerId);
                dragging.current = true;
                fromPointer(e);
              }}
              onPointerMove={(e) => dragging.current && fromPointer(e)}
              onKeyDown={onWheelKey}
            >
              <span
                aria-hidden
                className="pointer-events-none absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-foreground shadow"
                style={{ left: `${50 + dot.x * 50}%`, top: `${50 + dot.y * 50}%`, background: css(rgb) }}
              />
            </div>
            <div className="grid min-w-0 flex-1 gap-2">
              <div className="grid grid-cols-3 gap-1" role="group" aria-label={t("editor.color.hsv")}>
                {numberField(t("editor.color.hsvH"), Math.round(hsv.h), (n) => commit(fromHsv({ ...hsv, h: n })), "w-full")}
                {numberField(t("editor.color.hsvS"), Math.round(hsv.s * 100), (n) => commit(fromHsv({ ...hsv, s: n / 100 })), "w-full")}
                {numberField(t("editor.color.hsvV"), Math.round(hsv.v * 100), (n) => commit(fromHsv({ ...hsv, v: n / 100 })), "w-full")}
              </div>
              <label className="grid gap-0.5 text-[11px] text-muted-foreground" title={t("editor.color.brightnessHint")}>
                {t("editor.color.brightness", { value: Math.round(hsv.v * 100) })}
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(hsv.v * 100)}
                  aria-label={t("editor.color.brightnessLabel")}
                  aria-valuetext={`${Math.round(hsv.v * 100)}%`}
                  className="h-3 w-full cursor-pointer appearance-none rounded-full border border-border accent-foreground"
                  style={{ background: valueGradient(hsv) }}
                  onChange={(e) => {
                    dragging.current = true;
                    setDraft(fromHsv({ ...hsv, v: Number(e.target.value) / 100 }));
                  }}
                  onKeyUp={() => draft && commit(draft)}
                />
              </label>
              {hexField}
            </div>
          </div>
          ) : (
            <div className="grid gap-1.5">
              {(["r", "g", "b"] as const).map((ch, i) =>
                gradientSlider(t(`editor.color.${ch}`), ch.toUpperCase(), shown.rgb[i], 0, 255, "", channelGradient(shown.rgb, i), (v) => {
                  const next: Rgb = [...shown.rgb];
                  next[i] = clamp(Math.round(v), 0, 255);
                  return asRgb(next);
                }),
              )}
              {hexField}
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground">{t("editor.color.white")}</span>
            <Segmented<WhiteStrategy>
              ariaLabel={t("editor.color.white")}
              value={white}
              options={(["off", "preserve", "boost"] as const).map((w) => ({
                value: w,
                label: t(`editor.color.whites.${w}`),
                title: t(`editor.color.whiteHints.${w}`),
              }))}
              onChange={(w) => commit({ kind: "rgb", rgb: shown.rgb, ...(w !== "preserve" ? { white: w } : {}) })}
            />
          </div>
        </div>
      )}

      {mode === "kelvin" && shown.kind === "kelvin" && (
        <div className="grid gap-2">
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={MIN_K}
              max={MAX_K}
              step={50}
              value={shown.kelvin}
              aria-label={t("editor.color.kelvin")}
              aria-valuetext={`${shown.kelvin}K`}
              className="h-3 w-full cursor-pointer appearance-none rounded-full accent-foreground"
              style={{ background: KELVIN_BACKGROUND }}
              onChange={(e) => {
                dragging.current = true;
                setDraft({ kind: "kelvin", kelvin: Number(e.target.value) });
              }}
              onKeyUp={() => draft && commit(draft)}
            />
            {numberField(t("editor.color.kelvinValue"), shown.kelvin, (n) => commit({ kind: "kelvin", kelvin: clamp(Math.round(n), 1000, 40_000) }), "w-16")}
          </div>
          <div className="flex flex-wrap gap-1">
            {KELVIN_PRESETS.map((k) => (
              <Button
                key={k}
                type="button"
                variant={shown.kelvin === k ? "secondary" : "outline"}
                size="sm"
                className="num h-7 px-2 text-xs"
                aria-pressed={shown.kelvin === k}
                onClick={() => commit({ kind: "kelvin", kelvin: k })}
              >
                {k}K
              </Button>
            ))}
          </div>
        </div>
      )}

      {mode === "manual" && shown.kind === "manual" && (
        <div className="grid gap-1.5">
          {emitters.length === 0 && <p className="text-xs text-muted-foreground">{t("editor.color.noEmitters")}</p>}
          {emitters.map((p) => {
            const key = p.function as EmitterKey;
            const level = shown.values[key] ?? 0;
            return (
              <label key={p.function} className="grid grid-cols-[4.5rem_1fr_2.5rem] items-center gap-2 text-xs">
                <span className="truncate text-muted-foreground">{t(`fixtures.functions.${p.function}`)}</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(level * 100)}
                  aria-label={t("editor.color.emitterLevel", { name: t(`fixtures.functions.${p.function}`) })}
                  className="w-full accent-primary"
                  onChange={(e) => {
                    dragging.current = true;
                    setDraft({ kind: "manual", values: { ...shown.values, [key]: Number(e.target.value) / 100 } });
                  }}
                  onKeyUp={() => draft && commit(draft)}
                />
                <span className="num text-right text-muted-foreground">{Math.round(level * 100)}%</span>
              </label>
            );
          })}
        </div>
      )}

      <div className="grid gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted-foreground">{t("editor.color.palette")}</span>
          {EyeDropperCtor && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label={t("editor.color.eyedropper")}
              title={t("editor.color.eyedropper")}
              onClick={() => {
                void new EyeDropperCtor()
                  .open()
                  .then((r) => {
                    const parsed = hexToRgb(r.sRGBHex);
                    if (parsed) {
                      commit({ kind: "rgb", rgb: parsed });
                    }
                  })
                  .catch(() => undefined);
              }}
            >
              <Pipette aria-hidden />
            </Button>
          )}
        </div>
        <div className="flex flex-wrap gap-1">{PALETTE.map((p) => swatch(p.id, p.color, t(`editor.color.swatches.${p.id}`)))}</div>
        {recent.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-[11px] text-muted-foreground">{t("editor.color.recent")}</span>
            {recent.map((c, i) => swatch(`recent-${i}`, c, t("editor.color.recentItem", { hex: rgbToHex(colorValueRgb(c)) })))}
          </div>
        )}
      </div>

      {output && (
        <div className="grid gap-1.5 rounded-md border border-border p-2" aria-label={t("editor.color.output")}>
          <div className="flex items-center gap-2">
            <span
              role="img"
              aria-label={t("editor.color.outputSwatch", { hex: rgbToHex(output.rgb) })}
              className="size-6 rounded-sm border border-border bg-(--out)"
              style={{ "--out": css(output.rgb) } as CSSProperties}
            />
            <span className="text-xs">{t("editor.color.output")}</span>
            <span className="truncate text-[11px] text-muted-foreground">{target?.model.name}</span>
          </div>
          {output.emitters.map((lv) => (
            <div key={lv.fn} className="grid grid-cols-[4.5rem_1fr_2.5rem] items-center gap-2 text-[11px]">
              <span className="truncate text-muted-foreground">{t(`fixtures.functions.${lv.fn}`)}</span>
              <div
                role="meter"
                aria-label={t("fixtures.functions." + lv.fn)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(lv.level * 100)}
                className="h-1.5 overflow-hidden rounded-full bg-muted"
              >
                <div className="h-full bg-foreground/70" style={{ width: `${lv.level * 100}%` }} />
              </div>
              <span className="num text-right text-muted-foreground">{Math.round(lv.level * 100)}%</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

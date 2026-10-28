import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Dices, Minus, Plus, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Segmented } from "@/shared/components/Segmented";
import type { EffectPatch } from "../lib/cueOps";
import { cssColor } from "../lib/cueTemplates";
import {
  EFFECT_PRESETS,
  MAX_EFFECT_COLORS,
  MAX_PERIOD_BEATS,
  MAX_PERIOD_MS,
  MIN_EFFECT_COLORS,
  MIN_PERIOD_BEATS,
} from "../lib/effectPresets";
import { effectRateHz, FALLBACK_BPM, MAX_SAFE_STROBE_HZ, MIN_PERIOD_MS } from "../lib/effects";
import type { EffectCue, EffectId, Rgb, Tempo } from "../lib/project";
import { ColorSection } from "./ColorSection";
import { CommitInput } from "./CommitInput";
import { InspectorSection } from "./InspectorSection";
import { SliderField } from "./SliderField";

interface EffectInspectorProps {
  /** 选中的特效 Cue（至少一个）；显示第一个的值，其余在不一致时标“混合值”。 */
  cues: readonly EffectCue[];
  tempo: Tempo | null;
  /**
   * 提交对全部选中特效的修改。
   *
   * @param patch 要修改的参数。
   */
  onPatch: (patch: EffectPatch) => void;
}

/** 这些特效完全不使用颜色列表。 */
const COLORLESS: ReadonlySet<EffectId> = new Set(["rainbow"]);

/** 判断一批特效在某个参数上是否取值不一致。 */
function differs<T>(cues: readonly EffectCue[], pick: (c: EffectCue) => T): boolean {
  const first = JSON.stringify(pick(cues[0]));
  return cues.some((c) => JSON.stringify(pick(c)) !== first);
}

/**
 * 特效参数面板：类型、颜色列表（1~4 个）、周期（毫秒或拍数）、沿灯具的相位扩散、方向、亮度范围，
 * 闪烁特效还有随机种子。频闪超过 10 Hz 会提醒（快速闪烁可能引发不适）。
 *
 * 各字段在“松手 / 失焦 / Enter”时提交一次，一次提交对应一步撤销。
 * 输出 Cue 页的两个可折叠分区：“特效参数”与“特效颜色”。
 */
export function EffectInspector({ cues, tempo, onPatch }: EffectInspectorProps) {
  const { t } = useTranslation();
  const first = cues[0];
  const [colorIndex, setColorIndex] = useState(0);
  const index = Math.min(colorIndex, first.colors.length - 1);
  const mixedLabel = t("editor.cue.mixed");
  const mixed = (flag: boolean) => (flag ? <span className="ml-1.5 text-muted-foreground">{mixedLabel}</span> : null);

  const setColor = (at: number, rgb: Rgb) =>
    onPatch({ colors: first.colors.map((c, i) => (i === at ? rgb : c)) });
  const addColor = () => {
    const seed = first.colors[first.colors.length - 1] ?? [255, 255, 255];
    onPatch({ colors: [...first.colors, [...seed]] });
    setColorIndex(first.colors.length);
  };
  const removeColor = () => {
    onPatch({ colors: first.colors.filter((_, i) => i !== index) });
    setColorIndex(Math.max(0, index - 1));
  };

  const bpm = tempo?.bpm ?? FALLBACK_BPM;
  const period = first.period;
  const switchPeriod = (kind: "ms" | "beats") => {
    if (kind === period.kind) return;
    onPatch({
      period:
        kind === "beats"
          ? { kind: "beats", beats: (period.kind === "ms" ? period.ms : 0) * bpm / 60_000 }
          : { kind: "ms", ms: (period.kind === "beats" ? period.beats : 0) * 60_000 / bpm },
    });
  };
  const hz = effectRateHz(period, tempo);
  const risky = first.effect === "strobe" && hz > MAX_SAFE_STROBE_HZ;

  const colorsSection = (
    <InspectorSection
      scope="cue"
      id="effectColors"
      title={t("editor.effect.colorsTitle")}
      aside={
        COLORLESS.has(first.effect) ? null : (
          <span className="flex gap-0.5" aria-hidden>
            {first.colors.map((c, i) => (
              <span key={i} className="size-3 rounded-sm border border-border" style={{ backgroundColor: cssColor(c) }} />
            ))}
          </span>
        )
      }
    >
      {COLORLESS.has(first.effect) ? (
        <p className="text-xs text-muted-foreground">{t("editor.effect.noColors")}</p>
      ) : (
        <div className="grid gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">{differs(cues, (c) => c.colors) ? mixedLabel : null}</span>
            <span className="flex gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                disabled={first.colors.length >= MAX_EFFECT_COLORS}
                aria-label={t("editor.effect.addColor")}
                title={t("editor.effect.addColor")}
                onClick={addColor}
              >
                <Plus aria-hidden />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                disabled={first.colors.length <= MIN_EFFECT_COLORS}
                aria-label={t("editor.effect.removeColor")}
                title={t("editor.effect.removeColor")}
                onClick={removeColor}
              >
                <Minus aria-hidden />
              </Button>
            </span>
          </div>
          <div role="group" aria-label={t("editor.effect.colors")} className="flex gap-1.5">
            {first.colors.map((c, i) => (
              <button
                key={i}
                type="button"
                aria-label={t("editor.effect.colorN", { n: i + 1 })}
                aria-pressed={i === index}
                onClick={() => setColorIndex(i)}
                className={cn(
                  "size-8 rounded-md border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  i === index && "ring-2 ring-primary",
                )}
                style={{ backgroundColor: cssColor(c) }}
              />
            ))}
          </div>
          <ColorSection
            key={`${cues.map((c) => c.id).join(",")}-${index}`}
            rgb={first.colors[index]}
            mixed={false}
            onCommit={(rgb) => setColor(index, rgb)}
          />
        </div>
      )}
    </InspectorSection>
  );

  // 两个分区：特效参数、特效颜色（选中第几个颜色的状态放在这里，收起颜色分区不会丢）
  return (
    <>
    <InspectorSection scope="cue" id="effect" title={t("editor.effect.title")}>
      <div className="flex flex-col gap-4">
      <div className="grid gap-1.5">
        <Label className="text-xs" htmlFor="effect-type">
          {t("editor.effect.type")}
          {mixed(differs(cues, (c) => c.effect))}
        </Label>
        <Select value={first.effect} onValueChange={(v) => onPatch({ effect: v as EffectId })}>
          <SelectTrigger id="effect-type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EFFECT_PRESETS.map((p) => (
              <SelectItem key={p.effect} value={p.effect}>
                {t(`editor.effects.${p.effect}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{t(`editor.effects.${first.effect}Hint`)}</p>
      </div>

      <div className="grid gap-1.5">
        <Label className="text-xs">
          {t("editor.effect.period")}
          {mixed(differs(cues, (c) => c.period))}
        </Label>
        <Segmented<"ms" | "beats">
          ariaLabel={t("editor.effect.periodUnit")}
          value={period.kind}
          options={[
            { value: "ms", label: t("editor.effect.unitMs") },
            { value: "beats", label: t("editor.effect.unitBeats") },
          ]}
          onChange={switchPeriod}
        />
        <div className="flex items-center gap-2">
          <CommitInput
            className="num h-8 w-28 px-2 text-sm"
            inputMode="numeric"
            label={t("editor.effect.periodValue")}
            value={period.kind === "ms" ? period.ms : period.beats}
            onCommit={(text) => {
              const n = Number(text);
              if (!Number.isFinite(n)) return;
              onPatch({ period: period.kind === "ms" ? { kind: "ms", ms: n } : { kind: "beats", beats: n } });
            }}
          />
          <span className="text-xs text-muted-foreground">
            {period.kind === "ms"
              ? t("editor.effect.rangeMs", { min: MIN_PERIOD_MS, max: MAX_PERIOD_MS })
              : t("editor.effect.rangeBeats", { min: MIN_PERIOD_BEATS, max: MAX_PERIOD_BEATS })}
            {" · "}
            <span className="num">{hz.toFixed(1)} Hz</span>
          </span>
        </div>
        {period.kind === "beats" && !tempo && (
          <p className="text-xs text-muted-foreground">{t("editor.effect.noTempo", { bpm: FALLBACK_BPM })}</p>
        )}
        {risky && (
          <p role="alert" className="flex items-start gap-2 text-xs text-warning">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {t("editor.effect.strobeWarning", { hz: hz.toFixed(1), limit: MAX_SAFE_STROBE_HZ })}
          </p>
        )}
      </div>

      <SliderField
        label={t("editor.effect.spread")}
        numberLabel={t("editor.cue.numberOf", { field: t("editor.effect.spread") })}
        value={first.phaseSpread * 100}
        min={0}
        max={100}
        unit="%"
        mixed={differs(cues, (c) => c.phaseSpread)}
        mixedLabel={mixedLabel}
        onCommit={(v) => onPatch({ phaseSpread: v / 100 })}
      />

      <div className="grid gap-1.5">
        <Label className="text-xs">
          {t("editor.effect.direction")}
          {mixed(differs(cues, (c) => c.direction))}
        </Label>
        <Segmented<"1" | "-1">
          ariaLabel={t("editor.effect.direction")}
          value={first.direction === 1 ? "1" : "-1"}
          options={[
            { value: "1", label: t("editor.effect.forward") },
            { value: "-1", label: t("editor.effect.reverse") },
          ]}
          onChange={(v) => onPatch({ direction: v === "1" ? 1 : -1 })}
        />
      </div>

      <SliderField
        label={t("editor.effect.rangeMin")}
        numberLabel={t("editor.cue.numberOf", { field: t("editor.effect.rangeMin") })}
        value={first.range[0]}
        min={0}
        max={100}
        unit="%"
        mixed={differs(cues, (c) => c.range[0])}
        mixedLabel={mixedLabel}
        onCommit={(v) => onPatch({ range: [v, first.range[1]] })}
      />
      <SliderField
        label={t("editor.effect.rangeMax")}
        numberLabel={t("editor.cue.numberOf", { field: t("editor.effect.rangeMax") })}
        value={first.range[1]}
        min={0}
        max={100}
        unit="%"
        mixed={differs(cues, (c) => c.range[1])}
        mixedLabel={mixedLabel}
        onCommit={(v) => onPatch({ range: [first.range[0], v] })}
      />

      {first.effect === "sparkle" && (
        <div className="grid gap-1.5">
          <Label className="text-xs">{t("editor.effect.seed")}</Label>
          <div className="flex items-center gap-2">
            <CommitInput
              className="num h-8 w-32 px-2 text-sm"
              inputMode="numeric"
              label={t("editor.effect.seed")}
              value={first.seed}
              onCommit={(text) => {
                const n = Number(text);
                if (Number.isFinite(n)) onPatch({ seed: n });
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 gap-1.5"
              onClick={() => onPatch({ seed: Math.floor(Math.random() * 4_294_967_296) })}
            >
              <Dices aria-hidden />
              {t("editor.effect.reroll")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t("editor.effect.seedHint")}</p>
        </div>
      )}
      </div>
    </InspectorSection>
    {colorsSection}
    </>
  );
}

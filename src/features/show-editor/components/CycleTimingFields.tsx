import { useTranslation } from "react-i18next";

import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Segmented } from "@/shared/components/Segmented";
import { clampPeriod, PERIOD_MODES, periodModeOf, withPeriodMode, type PeriodMode } from "../lib/curveTiming";
import type { Curve, CycleTiming, Tempo } from "../lib/project";
import { CommitInput } from "./CommitInput";

/** 缓动选项（“默认”之后的顺序）。 */
const EASES: readonly Curve[] = ["linear", "hold", "easeIn", "easeOut", "easeInOut", "sCurve"];

interface CycleTimingFieldsProps {
  /** 当前计时 */
  timing: CycleTiming;
  /** 合并修改（值为 `undefined` 的字段表示清除） */
  onChange: (patch: Partial<CycleTiming>) => void;
  /** 片段长度（切换周期方式时保持速度） */
  lengthMs: number;
  tempo: Tempo | null;
  /** 无障碍名称前缀（例如“强度曲线”） */
  name: string;
}

/**
 * 周期与过渡的编辑（数值曲线、颜色序列共用）：
 *
 * - 周期：片段内次数 / 毫秒 / 拍，切换时保持当前速度；按时间计时可选“按节拍对齐”；
 * - 相位、过渡占比（%）、缓动（默认 = 按形状本身）。
 */
export function CycleTimingFields({ timing, onChange, lengthMs, tempo, name }: CycleTimingFieldsProps) {
  const { t } = useTranslation();
  const mode = periodModeOf(timing);
  const number = (label: string, value: number, commit: (n: number) => void, unit?: string) => (
    <label className="grid gap-1 text-xs text-muted-foreground">
      {label}
      <span className="flex items-center gap-1">
        <CommitInput
          className="num h-7 px-1.5 text-xs"
          inputMode="numeric"
          label={`${name} · ${label}`}
          value={Number(value.toFixed(2))}
          onCommit={(text) => {
            const n = Number(text);
            if (Number.isFinite(n)) commit(n);
          }}
        />
        {unit && <span>{unit}</span>}
      </span>
    </label>
  );

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Label className="text-xs">{t("editor.curve.period")}</Label>
        <Segmented<PeriodMode>
          size="xs"
          ariaLabel={`${name} · ${t("editor.curve.period")}`}
          value={mode}
          options={PERIOD_MODES.map((m) => ({ value: m, label: t(`editor.curve.periodModes.${m}`) }))}
          onChange={(m) => onChange(withPeriodMode(timing, m, { lengthMs, tempo }))}
        />
        {timing.period && (
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground" title={t("editor.curve.syncHint")}>
            <Checkbox
              aria-label={`${name} · ${t("editor.curve.sync")}`}
              checked={timing.sync === "beat"}
              onCheckedChange={(v) => onChange({ sync: v === true ? "beat" : undefined })}
            />
            {t("editor.curve.sync")}
          </label>
        )}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {mode === "cycles" && number(t("editor.look.cycles"), timing.cycles, (n) => onChange({ cycles: Math.min(1000, Math.max(1, Math.round(n * 100) / 100)) }))}
        {timing.period?.kind === "ms" && number(t("editor.curve.periodMs"), timing.period.ms, (n) => onChange({ period: clampPeriod({ kind: "ms", ms: n }) }), "ms")}
        {timing.period?.kind === "beats" &&
          number(t("editor.curve.periodBeats"), timing.period.beats, (n) => onChange({ period: clampPeriod({ kind: "beats", beats: n }) }), t("editor.curve.beatUnit"))}
        {number(t("editor.look.phase"), timing.phase, (n) => onChange({ phase: Math.min(1, Math.max(0, n)) }))}
        {number(t("editor.curve.transition"), (timing.transition ?? 1) * 100, (n) => {
          const v = Math.min(100, Math.max(0, n)) / 100;
          onChange({ transition: v >= 1 ? undefined : v });
        }, "%")}
      </div>
      <div className="flex items-center gap-2">
        <Label className="text-xs" title={t("editor.curve.transitionHint")}>
          {t("editor.curve.ease")}
        </Label>
        <Select value={timing.ease ?? "default"} onValueChange={(v) => onChange({ ease: v === "default" ? undefined : (v as Curve) })}>
          <SelectTrigger className="h-7 w-32 text-xs" aria-label={`${name} · ${t("editor.curve.ease")}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">{t("editor.curve.easeDefault")}</SelectItem>
            {EASES.map((c) => (
              <SelectItem key={c} value={c}>
                {t(`editor.look.curves.${c}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

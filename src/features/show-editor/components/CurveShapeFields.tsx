import { useTranslation } from "react-i18next";
import { Dices } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { announce } from "@/shared/stores/announcerStore";
import { formatSteps, parseSteps, randomSeed } from "../lib/curveTiming";
import type { ValueCurve } from "../lib/project";
import { CommitInput } from "./CommitInput";

interface CurveShapeFieldsProps {
  curve: ValueCurve;
  /** 合并修改（值为 `undefined` 的字段表示清除） */
  onChange: (patch: Partial<ValueCurve>) => void;
  /** 无障碍名称前缀 */
  name: string;
}

/**
 * 与形状相关的参数：方波的占空比、随机 / 噪声的“每台灯不同”与种子、步进波形的每一步。
 * 其它形状没有额外参数时不渲染任何东西。
 */
export function CurveShapeFields({ curve, onChange, name }: CurveShapeFieldsProps) {
  const { t } = useTranslation();
  const { shape } = curve;

  if (shape === "square") {
    return (
      <label className="grid gap-1 text-xs text-muted-foreground">
        {t("editor.curve.duty")}
        <span className="flex items-center gap-1">
          <CommitInput
            className="num h-7 w-20 px-1.5 text-xs"
            inputMode="numeric"
            label={`${name} · ${t("editor.curve.duty")}`}
            value={Math.round((curve.duty ?? 0.5) * 100)}
            onCommit={(text) => {
              const n = Number(text);
              if (Number.isFinite(n)) onChange({ duty: Math.min(100, Math.max(1, n)) / 100 });
            }}
          />
          %
        </span>
      </label>
    );
  }

  if (shape === "random" || shape === "noise") {
    const own = curve.seed !== undefined;
    return (
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground" title={t("editor.curve.perFixtureHint")}>
          <Checkbox
            aria-label={`${name} · ${t("editor.curve.perFixture")}`}
            checked={own}
            onCheckedChange={(v) => onChange({ seed: v === true ? randomSeed() : undefined })}
          />
          {t("editor.curve.perFixture")}
        </label>
        {own && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={() => {
              onChange({ seed: randomSeed() });
              announce(t("editor.curve.reseeded"));
            }}
          >
            <Dices aria-hidden className="size-3.5" />
            {t("editor.curve.reseed")}
          </Button>
        )}
      </div>
    );
  }

  if (shape === "steps") {
    return (
      <label className="grid gap-1 text-xs text-muted-foreground" title={t("editor.curve.stepsHint")}>
        {t("editor.curve.steps")}
        <CommitInput
          className="num h-7 px-1.5 text-xs"
          label={`${name} · ${t("editor.curve.steps")}`}
          value={formatSteps(curve.steps ?? [])}
          onCommit={(text) => {
            const steps = parseSteps(text);
            if (steps) onChange({ steps });
            else announce(t("editor.curve.stepsInvalid"));
          }}
        />
      </label>
    );
  }

  return null;
}

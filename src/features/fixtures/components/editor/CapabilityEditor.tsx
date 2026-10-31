import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Plus, SplitSquareHorizontal, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { nextCapability, splitCapabilities } from "../../lib/draft";
import { capabilityText } from "../../lib/format";
import { isGoboSlot, resolvePatterns } from "../../lib/gobos";
import type { Capability, FixtureProperty } from "../../lib/types";
import { GoboPicker } from "./GoboPicker";

interface CapabilityEditorProps {
  property: FixtureProperty;
  onChange: (capabilities: Capability[] | undefined) => void;
  /** 行号（1 起），用于读屏标签 */
  row: number;
}

const toHex = (c: [number, number, number] | undefined) =>
  c ? `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}` : "#ffffff";

const fromHex = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16) || 0,
  parseInt(hex.slice(3, 5), 16) || 0,
  parseInt(hex.slice(5, 7), 16) || 0,
];

/**
 * 能力区间编辑器：上方是 0~最大值的分段色条（视觉辅助），下方逐段编辑起止值、名称，
 * 比例区间可填起止物理量与单位，颜色轮槽位可指定代表色，图案槽位可指定 3D 舞台投射的图案。
 *
 * 常用操作：“添加区间”从上一段结束处续到最大值；“均分”一次生成 N 段阶梯区间（图案盘、颜色轮）。
 */
export function CapabilityEditor({ property, onChange, row }: CapabilityEditorProps) {
  const { t } = useTranslation();
  const caps = property.capabilities ?? [];
  const max = property.width === 2 ? 65535 : 255;
  const [splitCount, setSplitCount] = useState(8);
  const showColor = property.function === "colorWheel";
  const showGobo = property.function === "gobo";
  // 自动匹配的图案只看名称与序号，所以按“不带指定图案”的区间算
  const autoPatterns = showGobo ? resolvePatterns(caps.map((c) => ({ ...c, pattern: undefined }))) : [];

  const set = (next: Capability[]) => onChange(next.length > 0 ? next : undefined);
  const patch = (i: number, changes: Partial<Capability>) =>
    set(caps.map((c, j) => (j === i ? { ...c, ...changes } : c)));
  const label = (field: string, n: number) => t("fixtures.editor.capField", { row, n, field });

  return (
    <div className="grid gap-2">
      <CapabilityBand caps={caps} max={max} />
      {caps.length > 0 && (
        <ul className="grid gap-1.5" aria-label={t("fixtures.editor.capabilities")}>
          {caps.map((c, i) => (
            <li key={i} className="flex flex-wrap items-center gap-1.5">
              <Input
                className="num h-8 w-20 px-2"
                inputMode="numeric"
                aria-label={label(t("fixtures.editor.capFrom"), i + 1)}
                value={c.range[0]}
                onChange={(e) => patch(i, { range: [Number(e.target.value) || 0, c.range[1]] })}
              />
              <span aria-hidden className="text-muted-foreground">–</span>
              <Input
                className="num h-8 w-20 px-2"
                inputMode="numeric"
                aria-label={label(t("fixtures.editor.capTo"), i + 1)}
                value={c.range[1]}
                onChange={(e) => patch(i, { range: [c.range[0], Number(e.target.value) || 0] })}
              />
              <Input
                className="h-8 min-w-32 flex-1 px-2"
                aria-label={label(t("fixtures.editor.capLabel"), i + 1)}
                placeholder={t("fixtures.editor.capLabel")}
                value={c.label}
                onChange={(e) => patch(i, { label: e.target.value })}
              />
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Switch
                  checked={c.proportional === true}
                  onCheckedChange={(v) =>
                    patch(i, v ? { proportional: true } : { proportional: undefined, physical: undefined, unit: undefined })
                  }
                  aria-label={label(t("fixtures.editor.capProportional"), i + 1)}
                />
                {t("fixtures.editor.capProportional")}
              </label>
              {c.proportional && (
                <>
                  <Input
                    className="num h-8 w-20 px-2"
                    inputMode="decimal"
                    aria-label={label(t("fixtures.editor.capPhysicalStart"), i + 1)}
                    placeholder={t("fixtures.editor.capPhysicalStart")}
                    value={c.physical?.[0] ?? ""}
                    onChange={(e) => patch(i, { physical: [Number(e.target.value) || 0, c.physical?.[1] ?? 0] })}
                  />
                  <Input
                    className="num h-8 w-20 px-2"
                    inputMode="decimal"
                    aria-label={label(t("fixtures.editor.capPhysicalEnd"), i + 1)}
                    placeholder={t("fixtures.editor.capPhysicalEnd")}
                    value={c.physical?.[1] ?? ""}
                    onChange={(e) => patch(i, { physical: [c.physical?.[0] ?? 0, Number(e.target.value) || 0] })}
                  />
                  <Input
                    className="h-8 w-16 px-2"
                    aria-label={label(t("fixtures.editor.capUnit"), i + 1)}
                    placeholder={t("fixtures.editor.capUnit")}
                    value={c.unit ?? ""}
                    onChange={(e) => patch(i, { unit: e.target.value || undefined })}
                  />
                </>
              )}
              {showColor && (
                <input
                  type="color"
                  className="h-8 w-10 cursor-pointer rounded-md border border-border bg-transparent"
                  aria-label={label(t("fixtures.editor.capColor"), i + 1)}
                  value={toHex(c.color)}
                  onChange={(e) => patch(i, { color: fromHex(e.target.value) })}
                />
              )}
              {showGobo && isGoboSlot(c) && (
                <GoboPicker
                  value={c.pattern}
                  auto={autoPatterns[i] ?? null}
                  label={label(t("fixtures.gobos.pattern"), i + 1)}
                  onChange={(pattern) => patch(i, { pattern })}
                />
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label={t("fixtures.editor.capRemove", { row, n: i + 1 })}
                onClick={() => set(caps.filter((_, j) => j !== i))}
              >
                <Trash2 aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={nextCapability(caps, property.width) === null}
          onClick={() => {
            const next = nextCapability(caps, property.width);
            if (next) set([...caps, next]);
          }}
        >
          <Plus aria-hidden />
          {t("fixtures.editor.addCapability")}
        </Button>
        <span className="flex items-center gap-1.5">
          <Input
            className="num h-8 w-16 px-2"
            inputMode="numeric"
            aria-label={t("fixtures.editor.splitCount", { row })}
            value={splitCount}
            onChange={(e) => setSplitCount(Math.max(1, Math.min(64, Number(e.target.value) || 1)))}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              set(splitCapabilities(splitCount, property.width, (n) => t("fixtures.editor.capSlot", { n })))
            }
          >
            <SplitSquareHorizontal aria-hidden />
            {t("fixtures.editor.splitCapabilities")}
          </Button>
        </span>
      </div>
    </div>
  );
}

/**
 * 能力区间分段色条：每段宽度按 DMX 取值范围的比例，未覆盖的空洞画成虚线框。
 * 只是视觉辅助（区间内容在下方逐行可编辑），对读屏隐藏。
 */
export function CapabilityBand({ caps, max, className }: { caps: readonly Capability[]; max: number; className?: string }) {
  const total = max + 1;
  const pieces: { lo: number; hi: number; cap: Capability | null; index: number }[] = [];
  let cursor = 0;
  caps.forEach((cap, index) => {
    const lo = Math.max(cursor, Math.min(cap.range[0], max));
    const hi = Math.min(Math.max(cap.range[1], lo), max);
    if (lo > cursor) pieces.push({ lo: cursor, hi: lo - 1, cap: null, index: -1 });
    pieces.push({ lo, hi, cap, index });
    cursor = hi + 1;
  });
  if (cursor <= max) pieces.push({ lo: cursor, hi: max, cap: null, index: -1 });

  return (
    <div aria-hidden className={cn("flex h-7 w-full overflow-hidden rounded-md border border-border", className)}>
      {pieces.map((p) => {
        const style = {
          width: `${((p.hi - p.lo + 1) / total) * 100}%`,
          "--cap-color": p.cap?.color ? `rgb(${p.cap.color.join(" ")})` : undefined,
        } as CSSProperties;
        return (
          <div
            key={`${p.lo}-${p.hi}`}
            style={style}
            title={p.cap ? capabilityText({ ...p.cap, range: [p.lo, p.hi] }) : `${p.lo}–${p.hi}`}
            className={cn(
              "flex min-w-0 items-center justify-center truncate border-r border-background px-1 text-[0.65rem] last:border-r-0",
              p.cap === null && "border-dashed bg-transparent text-muted-foreground/60",
              p.cap !== null && p.cap.color && "bg-(--cap-color) text-foreground",
              p.cap !== null && !p.cap.color && (p.index % 2 === 0 ? "bg-primary/25" : "bg-primary/10"),
              p.cap?.proportional && !p.cap.color && "bg-primary/35",
            )}
          >
            {p.cap?.proportional ? `↗ ${p.cap.label}` : p.cap?.label}
          </div>
        );
      })}
    </div>
  );
}

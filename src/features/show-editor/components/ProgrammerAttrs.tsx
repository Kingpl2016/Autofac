import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { availableAttrsOf } from "../lib/fixtureProfile";
import { capabilityAt, capabilityValue } from "../lib/layers";
import { paramHead } from "../lib/looks";
import { knockout, programAttr, type ProgrammerValues } from "../lib/programmer";
import type { AttrKey, Look, ShowProject } from "../lib/project";
import { SliderField } from "./SliderField";

interface ProgrammerAttrsProps {
  project: Pick<ShowProject, "fixtures" | "fixtureModels">;
  /** 选中的灯具或像素引用 */
  selected: readonly string[];
  values: ProgrammerValues;
  /**
   * 写回编程器内容。
   *
   * @param next 新内容。
   */
  onChange: (next: Record<string, Look>) => void;
}

/**
 * 编程器的属性分区：按属性组（位置 / 光束 / 聚焦 / 控制 / 颜色类属性）列出选中灯具支持的属性，
 * 每个属性一个推子（有能力区间时可以直接选槽位 / 图案）和“去掉”按钮。
 *
 * 只写给支持该属性的灯；多台灯的值不一致时显示“不一致”；部分支持时标出台数。
 */
export function ProgrammerAttrs({ project, selected, values, onChange }: ProgrammerAttrsProps) {
  const { t } = useTranslation();
  const available = useMemo(() => availableAttrsOf(project, selected), [project, selected]);
  // 每台灯支持的属性（写入时跳过不支持的灯）
  const supportOf = useMemo(
    () => new Map(selected.map((id) => [id, new Set(availableAttrsOf(project, [id]).map((a) => a.key))])),
    [project, selected],
  );

  if (available.length === 0) return <p className="text-xs text-muted-foreground">{t("editor.programmer.noAttrs")}</p>;

  const groups = [...new Set(available.map((a) => a.group))];
  const targetsOf = (key: AttrKey) => selected.filter((id) => supportOf.get(id)?.has(key));

  return (
    <div className="grid gap-2">
      {groups.map((group) => (
        <div key={group} role="group" aria-label={t(`fixtures.groups.${group}`)} className="grid gap-2 rounded-md border border-border p-2">
          <span className="text-[11px] font-medium text-muted-foreground">{t(`fixtures.groups.${group}`)}</span>
          {available
            .filter((a) => a.group === group)
            .map((info) => {
              const key = info.key;
              const name = t(`fixtures.functions.${key}`);
              const targets = targetsOf(key);
              const programmed = targets.filter((id) => values[id]?.attrs?.[key] !== undefined);
              const head = programmed.map((id) => paramHead(values[id]?.attrs?.[key]) ?? 0);
              const value = head[0] ?? 0;
              const mixed = new Set(targets.map((id) => paramHead(values[id]?.attrs?.[key]) ?? null)).size > 1;
              const caps = info.capabilities;
              const capIndex = programmed.length > 0 ? capabilityAt(caps, value, info.max) : -1;
              const partial = info.supported < selected.length;
              return (
                <div key={key} className="grid gap-1">
                  <div className="flex items-center gap-1">
                    <div className={cn("min-w-0 flex-1", programmed.length === 0 && "opacity-80")}>
                      <SliderField
                        label={`${name} · ${info.name}`}
                        numberLabel={t("editor.layers.valueOf", { name })}
                        value={Math.round(value * 1000) / 10}
                        min={0}
                        max={100}
                        step={0.1}
                        decimals={1}
                        unit="%"
                        mixed={mixed}
                        mixedLabel={t("editor.cue.mixed")}
                        onCommit={(v) => onChange(programAttr(values, targets, key, v / 100))}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-6 self-start"
                      disabled={programmed.length === 0}
                      aria-label={t("editor.programmer.knockAttr", { name })}
                      title={t("editor.programmer.knockAttr", { name })}
                      onClick={() => onChange(knockout(values, selected, key))}
                    >
                      <X aria-hidden />
                    </Button>
                  </div>
                  {partial && (
                    <p className="text-[11px] text-muted-foreground">
                      {t("editor.layers.partial", { supported: info.supported, total: selected.length })}
                    </p>
                  )}
                  {caps.length > 0 && (
                    <Select
                      value={capIndex >= 0 ? String(capIndex) : ""}
                      onValueChange={(v) => {
                        const cap = caps[Number(v)];
                        if (cap) onChange(programAttr(values, targets, key, capabilityValue(cap, info.max)));
                      }}
                    >
                      <SelectTrigger className="h-7 text-xs" aria-label={t("editor.layers.capabilityOf", { name })}>
                        <SelectValue placeholder={t("editor.layers.capability")} />
                      </SelectTrigger>
                      <SelectContent>
                        {caps.map((c, i) => (
                          <SelectItem key={i} value={String(i)}>
                            {c.label || `${c.range[0]}–${c.range[1]}`}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              );
            })}
        </div>
      ))}
    </div>
  );
}

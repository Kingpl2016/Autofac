import { useTranslation } from "react-i18next";
import { Diamond, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { Engine } from "../engine/engine";
import { hasKeyAt, setValueAt, toggleKeyAt } from "../lib/keyframes";
import { capabilityAt, capabilityValue, type AttrInfo } from "../lib/layers";
import { fixed, paramHead } from "../lib/looks";
import type { AttrKey, Look } from "../lib/project";
import { SliderField } from "./SliderField";

interface AttributeLayersProps {
  look: Look;
  /** 目标灯具能编辑的属性 */
  available: readonly AttrInfo[];
  /** 片段内时刻（已夹在片段范围内） */
  uMs: number;
  /** 片段时长 */
  lengthMs: number;
  /** 播放头在片段内（能打关键帧） */
  inside: boolean;
  engine: Engine | null;
  /**
   * 修改外观（对每个选中片段按它自己的片段内时刻执行）。
   *
   * @param recipe 在外观草稿上修改。
   */
  edit: (recipe: (look: Look, uMs: number) => void) => void;
}

/**
 * 外观的属性层（位置 / 光束 / 聚焦 / 控制 / 颜色类属性）：按属性组分区列出已有的层，
 * 每层一个推子（有能力区间时可以直接选槽位 / 图案）、◆ 关键帧、× 删除；下方“添加属性层”列出目标灯具还没用到的功能。
 */
export function AttributeLayers({ look, available, uMs, lengthMs, inside, engine, edit }: AttributeLayersProps) {
  const { t } = useTranslation();
  const present = (Object.keys(look.attrs ?? {}) as AttrKey[]).filter((k) => look.attrs?.[k]);
  const infoOf = (key: AttrKey) => available.find((a) => a.key === key);
  const addable = available.filter((a) => !present.includes(a.key));
  const groups = [...new Set(present.map((k) => infoOf(k)?.group ?? "control"))];

  const valueAt = (key: AttrKey): number => {
    const p = look.attrs?.[key];
    if (!p) return 0;
    if (engine) {
      const v = engine.sampleNum(p, uMs, lengthMs);
      if (Number.isFinite(v)) return v;
    }
    return paramHead(p) ?? 0;
  };

  return (
    <section aria-label={t("editor.layers.title")} className="grid gap-2">
      <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{t("editor.layers.title")}</h4>
      {present.length === 0 && <p className="text-xs text-muted-foreground">{t("editor.layers.empty")}</p>}
      {groups.map((group) => (
        <div key={group} className="grid gap-2 rounded-md border border-border p-2">
          <span className="text-[11px] font-medium text-muted-foreground">{t(`fixtures.groups.${group}`)}</span>
          {present
            .filter((k) => (infoOf(k)?.group ?? "control") === group)
            .map((key) => {
              const info = infoOf(key);
              const name = t(`fixtures.functions.${key}`);
              const value = valueAt(key);
              const caps = info?.capabilities ?? [];
              const capIndex = info ? capabilityAt(caps, value, info.max) : -1;
              return (
                <div key={key} className="grid gap-1">
                  <div className="flex items-center gap-1">
                    <div className="min-w-0 flex-1">
                      <SliderField
                        label={info ? `${name} · ${info.name}` : name}
                        numberLabel={t("editor.layers.valueOf", { name })}
                        value={Math.round(value * 1000) / 10}
                        min={0}
                        max={100}
                        step={0.1}
                        decimals={1}
                        unit="%"
                        onCommit={(v) =>
                          edit((l, u) => {
                            l.attrs = { ...l.attrs, [key]: setValueAt(l.attrs?.[key], u, v / 100) };
                          })
                        }
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className={cn("size-6 self-start", hasKeyAt(look.attrs?.[key], uMs) && "text-keyframe")}
                      aria-pressed={hasKeyAt(look.attrs?.[key], uMs)}
                      aria-label={t("editor.look.keyOf", { name })}
                      title={t("editor.look.keyOf", { name })}
                      disabled={!inside || look.attrs?.[key]?.kind === "curve"}
                      onClick={() =>
                        edit((l, u) => {
                          l.attrs = { ...l.attrs, [key]: toggleKeyAt(l.attrs?.[key], u, value) };
                        })
                      }
                    >
                      <Diamond aria-hidden className={cn("size-3.5", hasKeyAt(look.attrs?.[key], uMs) && "fill-current")} />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-6 self-start"
                      aria-label={t("editor.layers.remove", { name })}
                      title={t("editor.layers.remove", { name })}
                      onClick={() =>
                        edit((l) => {
                          if (!l.attrs) return;
                          const { [key]: _gone, ...rest } = l.attrs;
                          void _gone;
                          l.attrs = rest;
                        })
                      }
                    >
                      <X aria-hidden />
                    </Button>
                  </div>
                  {caps.length > 0 && info && (
                    <Select
                      value={capIndex >= 0 ? String(capIndex) : ""}
                      onValueChange={(v) => {
                        const cap = caps[Number(v)];
                        if (cap) edit((l, u) => void (l.attrs = { ...l.attrs, [key]: setValueAt(l.attrs?.[key], u, capabilityValue(cap, info.max)) }));
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
      {addable.length > 0 && (
        <Select
          value=""
          onValueChange={(v) => {
            const info = available.find((a) => a.key === v);
            if (!info) return;
            // 新层从通道中点（Pan / Tilt 居中）或 0 开始
            const start = info.key === "pan" || info.key === "tilt" ? 0.5 : 0;
            edit((l) => void (l.attrs = { ...l.attrs, [info.key]: fixed(start) }));
          }}
        >
          <SelectTrigger className="h-8 text-xs" aria-label={t("editor.layers.add")}>
            <SelectValue placeholder={t("editor.layers.add")} />
          </SelectTrigger>
          <SelectContent>
            {addable.map((a) => (
              <SelectItem key={a.key} value={a.key}>
                {t(`fixtures.groups.${a.group}`)} · {t(`fixtures.functions.${a.key}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </section>
  );
}

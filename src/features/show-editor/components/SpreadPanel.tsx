import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { normalizeSpread, spreadKeysOf } from "../lib/layers";
import type { Look, Spread, SpreadKey } from "../lib/project";
import { CommitInput } from "./CommitInput";

/** 分布顺序的来源。 */
const ORDERS: readonly NonNullable<Spread["order"]>[] = ["members", "reverse", "stageX", "stageY"];

interface SpreadPanelProps {
  look: Look;
  spread: Spread | undefined;
  /** 轨道成员数（1 台时分布没有意义，面板只给提示） */
  members: number;
  /**
   * 提交新的分布（`undefined` 为不分布）。
   *
   * @param spread 分布。
   */
  onChange: (spread: Spread | undefined) => void;
}

/** 分布值的单位：强度 %、色相 °、相位与属性 %（0~1 显示为百分比）。 */
function unitOf(key: SpreadKey): string {
  return key === "hue" ? "°" : "%";
}

/** 界面数值 ↔ 存储数值（属性存 0~1）。 */
const toUi = (key: SpreadKey, v: number) => (key === "intensity" || key === "hue" ? v : Math.round(v * 1000) / 10);
const fromUi = (key: SpreadKey, v: number) => (key === "intensity" || key === "hue" ? v : v / 100);

/**
 * 多灯分布（Fan / MAtricks）：把一个外观片段在分组成员之间展开——
 * 数值从第一台到最后一台线性过渡（强度、色相偏移、任意属性），时间级联形成波浪，分翼做对称。
 */
export function SpreadPanel({ look, spread, members, onChange }: SpreadPanelProps) {
  const { t } = useTranslation();
  const values = spread?.values ?? {};
  const used = Object.keys(values) as SpreadKey[];
  const addable = spreadKeysOf(look).filter((k) => !used.includes(k));
  const set = (patch: Partial<Spread>) => onChange(normalizeSpread({ ...spread, ...patch }));
  const label = (key: SpreadKey) =>
    key === "intensity"
      ? t("editor.look.intensity")
      : key === "hue"
        ? t("editor.spread.hue")
        : key === "phase"
          ? t("editor.spread.phase")
          : t(`fixtures.functions.${key}`);

  const num = (aria: string, value: number, onValue: (n: number) => void, width = "w-16") => (
    <CommitInput
      className={`num h-7 px-1.5 text-xs ${width}`}
      inputMode="numeric"
      label={aria}
      value={value}
      onCommit={(text) => {
        const n = Number(text);
        if (Number.isFinite(n)) onValue(n);
      }}
    />
  );

  return (
    <section aria-label={t("editor.spread.title")} className="grid gap-2">
      <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{t("editor.spread.title")}</h4>
      {members < 2 ? (
        <p className="text-xs text-muted-foreground">{t("editor.spread.needGroup")}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">{t("editor.spread.order")}</span>
            <Select value={spread?.order ?? "members"} onValueChange={(v) => set({ order: v as Spread["order"] })}>
              <SelectTrigger className="h-7 w-28 text-xs" aria-label={t("editor.spread.order")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ORDERS.map((o) => (
                  <SelectItem key={o} value={o}>
                    {t(`editor.spread.orders.${o}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-muted-foreground">{t("editor.spread.wings")}</span>
            {num(t("editor.spread.wings"), spread?.wings ?? 1, (n) => set({ wings: Math.max(1, Math.min(64, Math.round(n))) }), "w-12")}
          </div>

          <div className="grid gap-1">
            {used.map((key) => {
              const v = values[key];
              if (!v) return null;
              return (
                <div key={key} className="flex items-center gap-1.5 text-xs">
                  <span className="w-16 truncate text-muted-foreground">{label(key)}</span>
                  {num(t("editor.spread.fromOf", { name: label(key) }), toUi(key, v.from), (n) =>
                    set({ values: { ...values, [key]: { ...v, from: fromUi(key, n) } } }),
                  )}
                  <span aria-hidden>→</span>
                  {num(t("editor.spread.toOf", { name: label(key) }), toUi(key, v.to), (n) =>
                    set({ values: { ...values, [key]: { ...v, to: fromUi(key, n) } } }),
                  )}
                  <span className="text-muted-foreground">{unitOf(key)}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    aria-label={t("editor.spread.remove", { name: label(key) })}
                    onClick={() => {
                      const { [key]: _gone, ...rest } = values;
                      void _gone;
                      set({ values: rest });
                    }}
                  >
                    <X aria-hidden />
                  </Button>
                </div>
              );
            })}
            {addable.length > 0 && (
              <Select
                value=""
                onValueChange={(v) => {
                  const key = v as SpreadKey;
                  const preset =
                    key === "intensity"
                      ? { from: 100, to: 0 }
                      : key === "hue"
                        ? { from: 0, to: 360 }
                        : key === "phase"
                          ? { from: 0, to: -(members - 1) / members }
                          : { from: 0, to: 1 };
                  set({ values: { ...values, [key]: preset } });
                }}
              >
                <SelectTrigger className="h-7 text-xs" aria-label={t("editor.spread.addValue")}>
                  <Plus aria-hidden className="size-3.5" />
                  <SelectValue placeholder={t("editor.spread.addValue")} />
                </SelectTrigger>
                <SelectContent>
                  {addable.map((k) => (
                    <SelectItem key={k} value={k}>
                      {label(k)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">{t("editor.spread.delay")}</span>
            {num(t("editor.spread.delayFrom"), spread?.delay?.fromMs ?? 0, (n) =>
              set({ delay: { fromMs: Math.max(0, Math.round(n)), toMs: spread?.delay?.toMs ?? 0 } }),
            )}
            <span aria-hidden>→</span>
            {num(t("editor.spread.delayTo"), spread?.delay?.toMs ?? 0, (n) =>
              set({ delay: { fromMs: spread?.delay?.fromMs ?? 0, toMs: Math.max(0, Math.round(n)) } }),
            )}
            <span className="text-muted-foreground">ms</span>
          </div>
          {spread && (
            <Button type="button" variant="ghost" size="sm" className="h-7 justify-start text-xs" onClick={() => onChange(undefined)}>
              {t("editor.spread.clear")}
            </Button>
          )}
        </>
      )}
    </section>
  );
}

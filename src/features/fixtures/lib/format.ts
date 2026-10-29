import type { Capability, FixtureModel, ImportWarning } from "./types";
import { endChannel } from "./validate";

/**
 * 通道范围文字：单通道为 `3`，多通道为 `1–2`。
 *
 * @param channel 起始通道。
 * @param width 占用通道数。
 */
export function channelRangeText(channel: number, width: 1 | 2): string {
  return width > 1 ? `${channel}–${endChannel({ channel, width })}` : String(channel);
}

/**
 * 按名称或编号过滤模型（忽略大小写和首尾空白）。
 *
 * @param models 全部模型。
 * @param query 搜索词；为空时不过滤。
 */
export function filterModels(models: readonly FixtureModel[], query: string): FixtureModel[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...models];
  return models.filter((m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
}

/** 物理量单位的显示写法（OFL 的 `deg` 写成 `°`）。 */
function unitText(unit: string | undefined): string {
  return unit === "deg" ? "°" : (unit ?? "");
}

/**
 * 能力区间的物理量文字：比例区间为 `0°–540°`，单值为 `20Hz`。
 *
 * @param cap 能力区间。
 * @returns 文字；没有物理量时为空串。
 */
export function physicalText(cap: Pick<Capability, "physical" | "unit">): string {
  if (!cap.physical) return "";
  const u = unitText(cap.unit);
  const fmt = (v: number) => `${Number(v.toFixed(2))}${u}`;
  const [a, b] = cap.physical;
  return a === b ? fmt(a) : `${fmt(a)}–${fmt(b)}`;
}

/**
 * 能力区间的完整说明：`DMX 起–止 名称（物理量）`，用于悬停提示与读屏文本。
 *
 * @param cap 能力区间。
 * @returns 说明文字。
 */
export function capabilityText(cap: Pick<Capability, "range" | "label" | "physical" | "unit">): string {
  const phys = physicalText(cap);
  const base = `${cap.range[0]}–${cap.range[1]} ${cap.label}`.trim();
  return phys && !cap.label.includes(phys) ? `${base}（${phys}）` : base;
}

/**
 * 一条导入警告对应的说明文案参数。
 *
 * @param w 警告。
 * @returns i18n 插值参数（缺失项以破折号占位）。
 */
export function warningParams(w: ImportWarning): Record<string, string | number> {
  return {
    sheet: w.sheet,
    row: w.row ?? "—",
    model: w.modelId ?? "—",
    detail: w.detail ?? "—",
  };
}

/**
 * 节目编辑器里“添加这个模型”的地址：编辑器打开左侧灯具页并展开该模型的批量添加面板。
 *
 * @param modelId 模型编号。
 * @returns 路由地址。
 */
export function addToShowHref(modelId: string): string {
  return `/editor?addFixture=${encodeURIComponent(modelId)}`;
}

import type { FixtureModel, ImportWarning } from "./types";
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

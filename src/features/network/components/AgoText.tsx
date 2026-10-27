import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { useNow } from "@/shared/hooks/useNow";
import { agoParts } from "../lib/format";

/**
 * 把“距今多久”翻译成文字，例如“3 秒前”“12 分钟前”。
 *
 * # Arguments
 *
 * * `t` - 翻译函数。
 * * `ts` - 过去某一时刻的时间戳（毫秒）。
 * * `now` - 当前时间戳（毫秒）。
 */
function agoText(t: TFunction, ts: number, now: number): string {
  const { unit, value } = agoParts(now - ts);
  return t(`network.ago.${unit}`, { n: value });
}

/** 自动刷新的“距今多久”文字（默认每 5 秒刷新一次）。 */
export function AgoText({ ts, intervalMs = 5000 }: { ts: number; intervalMs?: number }) {
  const { t } = useTranslation();
  const now = useNow(intervalMs);
  return <>{agoText(t, ts, Math.max(now, ts))}</>;
}

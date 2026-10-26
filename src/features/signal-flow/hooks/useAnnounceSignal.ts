import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { announce } from "@/shared/stores/announcerStore";
import { diffSignal, type SignalItem } from "../lib/signalChanges";

/** 一条播报里最多直接念出的名字数，其余折叠成“等 N 项”。 */
const MAX_NAMES = 3;

/**
 * 在列表视图里，把来源 / 目的地“有信号”状态的变化播报给读屏用户。
 *
 * 只在状态翻转时播报（有信号 ↔ 无信号），数值变化（pps）不播报，避免每秒刷屏；
 * 同一次刷新里的多处变化合并成一句话。
 *
 * @param items 当前需要关注的对象；传 `null` 表示此刻不播报（例如不在列表视图），
 *   并清除记忆，回到列表视图时不会把期间累计的变化一次性念出来。
 */
export function useAnnounceSignal(items: readonly SignalItem[] | null): void {
  const { t } = useTranslation();
  const prev = useRef<ReadonlyMap<string, SignalItem> | null>(null);

  useEffect(() => {
    if (!items) {
      prev.current = null;
      return;
    }
    const { gained, lost } = diffSignal(prev.current, items);
    prev.current = new Map(items.map((i) => [i.key, i]));

    const describe = (list: SignalItem[]) => {
      const names = list
        .slice(0, MAX_NAMES)
        .map((i) => t(`signalFlow.announce.${i.kind}`, { name: i.label }))
        .join(t("signalFlow.announce.separator"));
      const rest = list.length - MAX_NAMES;
      return rest > 0 ? `${names}${t("signalFlow.announce.more", { n: rest })}` : names;
    };
    const parts: string[] = [];
    if (gained.length > 0) parts.push(t("signalFlow.announce.gained", { names: describe(gained) }));
    if (lost.length > 0) parts.push(t("signalFlow.announce.lost", { names: describe(lost) }));
    if (parts.length > 0) announce(parts.join(t("signalFlow.announce.separator")));
  }, [items, t]);
}
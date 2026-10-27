import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { History } from "lucide-react";

import { cn } from "@/lib/utils";
import { changeLabelKey, describeChange } from "../lib/history";
import type { ShowProject } from "../lib/project";
import { HISTORY_LIMIT, useProjectStore } from "../stores/useProjectStore";

/**
 * 素材库的“历史”分区：按时间顺序列出每一步改动（由相邻快照推断），点击任一步回到那一步之后的状态
 * （多步撤销 / 重做）；当前位置高亮，已撤销的步骤变灰，做新修改后它们会被丢弃。
 */
export function HistoryTab() {
  const { t } = useTranslation();
  const current = useProjectStore((s) => s.project);
  const past = useStore(useProjectStore.temporal, (s) => s.pastStates);
  const future = useStore(useProjectStore.temporal, (s) => s.futureStates);

  // 状态序列：最早 … 上一步、当前、下一步 … 最晚（zundo 的 futureStates 末尾是紧接着的下一步）
  const states = useMemo<ShowProject[]>(
    () => [
      ...past.map((s) => s.project as ShowProject),
      current,
      ...[...future].reverse().map((s) => s.project as ShowProject),
    ],
    [past, future, current],
  );
  const at = past.length;

  const goTo = (k: number) => {
    const temporal = useProjectStore.temporal.getState();
    if (k < at) temporal.undo(at - k);
    else if (k > at) temporal.redo(k - at);
  };

  const label = (k: number) => {
    if (k === 0) return t("editor.history.start");
    const { key, count } = changeLabelKey(describeChange(states[k - 1], states[k]));
    return t(key, { count });
  };

  return (
    <div className="flex flex-col gap-2 p-2">
      <p className="px-1 text-xs text-muted-foreground">{t("editor.history.hint", { limit: HISTORY_LIMIT })}</p>
      <ol aria-label={t("editor.history.list")} className="flex flex-col">
        {states.map((_, k) => {
          const isCurrent = k === at;
          const undone = k > at;
          return (
            <li key={k}>
              <button
                type="button"
                aria-current={isCurrent ? "step" : undefined}
                onClick={() => goTo(k)}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors",
                  "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  isCurrent && "bg-primary/15 font-medium text-foreground",
                  undone && "text-muted-foreground opacity-60",
                )}
              >
                <span aria-hidden className="num w-6 shrink-0 text-right text-muted-foreground">
                  {k}
                </span>
                {k === 0 && <History aria-hidden className="size-3 shrink-0" />}
                <span className="min-w-0 flex-1 truncate">{label(k)}</span>
                {isCurrent && <span className="shrink-0 text-[10px] text-primary">{t("editor.history.current")}</span>}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

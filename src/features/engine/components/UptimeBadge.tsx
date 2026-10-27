import { Clock } from "lucide-react";
import { useTranslation } from "react-i18next";

import { formatUptime, splitUptime } from "@/shared/lib/uptime";
import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";

/**
 * 顶栏的引擎运行时长：用“已运行 3 小时 27 分”这种人话显示，悬停给出精确的 `h:mm:ss`。
 * 引擎刚启动、还没有数据时不显示。自己订阅每秒变化的时长，只重渲这一小块。
 */
export function UptimeBadge() {
  const { t } = useTranslation();
  const uptimeSec = useEngineStatusStore((s) => s.uptimeSec);
  if (!(uptimeSec > 0)) return null;

  const p = splitUptime(uptimeSec);
  const text = t(`statusBar.uptime_${p.unit}`, { d: p.days, h: p.hours, m: p.minutes, s: p.seconds });

  return (
    <span
      className="flex items-center gap-1.5 text-sm text-muted-foreground"
      title={t("statusBar.uptimeExact", { value: formatUptime(Math.floor(uptimeSec)) })}
    >
      <Clock className="size-4" aria-hidden />
      <span className="tabular">{t("statusBar.uptimeRunning", { text })}</span>
    </span>
  );
}

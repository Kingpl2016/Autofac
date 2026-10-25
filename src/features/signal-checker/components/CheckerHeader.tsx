import { useTranslation } from "react-i18next";
import { Activity } from "lucide-react";

import { StatusPill } from "@/shared/components/StatusPill";
import { useSenderStore } from "../stores/useSenderStore";

/**
 * 信号检测器顶栏：标题，右侧是发送状态、已发包数与实测频率。
 *
 * 频率显示的是后端每秒结算一次的实测值，不是写死的 44Hz——Windows 的计时粒度可能让实际值偏离目标。
 */
export function CheckerHeader() {
  const { t } = useTranslation();
  const status = useSenderStore((s) => s.status);
  const running = status?.running ?? false;
  const hz = running && status && status.measuredHz > 0 ? Math.round(status.measuredHz) : "--";

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card px-6">
      <Activity className="size-5 text-primary" aria-hidden />
      <h1 tabIndex={-1} className="text-base font-semibold tracking-tight outline-none">
        {t("signalChecker.title")}
      </h1>

      <div className="ml-auto flex items-center gap-4 text-sm">
        <StatusPill tone={running ? "playing" : "idle"}>
          {running ? t("signalChecker.sending") : t("signalChecker.idle")}
        </StatusPill>
        {running && status && (
          <span className="tabular text-muted-foreground">
            {t("signalChecker.packets", { n: status.packetsSent.toLocaleString() })}
          </span>
        )}
        <span className="tabular text-muted-foreground">
          {t("signalChecker.rate", { hz, n: status?.universeCount ?? 0 })}
        </span>
      </div>
    </header>
  );
}

import { useTranslation } from "react-i18next";

import { StatusPill } from "@/shared/components/StatusPill";
import { SurfacePanel } from "@/shared/components/SurfacePanel";
import type { OutputPayload } from "@/shared/domain/engine";
import { useNow } from "@/shared/hooks/useNow";
import { formatCount, formatDuration, formatPacketRate } from "@/shared/lib/format";
import { useOutputStore } from "@/shared/stores/outputStore";
import { ageNow, isOutputStale } from "@/shared/lib/outputFreshness";
import { outputTone } from "../lib/outputHealth";

interface OutputHealthViewProps {
  /** 最近一次输出统计；`null` 表示还没收到。 */
  output: OutputPayload | null;
  /** 收到该统计的时间戳。 */
  receivedAt: number | null;
  /** 当前时间戳。 */
  now: number;
}

/**
 * 输出健康条的纯展示部分：状态、会话累计的发送 / 错误 / 丢帧，以及最近一次错误。
 */
export function OutputHealthView({ output, receivedAt, now }: OutputHealthViewProps) {
  const { t } = useTranslation();
  const stale = isOutputStale(receivedAt, now);

  return (
    <SurfacePanel
      title={t("dashboard.output.title")}
      actions={
        <span className="text-xs text-muted-foreground">{t("dashboard.output.note")}</span>
      }
    >
      {!output ? (
        <p className="text-sm text-muted-foreground">{t("dashboard.output.waiting")}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
          <div role="status" className="flex flex-wrap items-center gap-2">
            <StatusPill tone={outputTone(output.state)}>
              {t(`dashboard.output.state.${output.state}`)}
            </StatusPill>
            {stale && <StatusPill tone="warning">{t("dashboard.output.stale")}</StatusPill>}
            {output.sender !== "ready" && (
              <span className="text-xs text-destructive">
                {t(`dashboard.output.sender.${output.sender}`)}
              </span>
            )}
          </div>

          <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
            <Metric label={t("dashboard.output.sent")} value={formatCount(output.sent)} />
            <Metric
              label={t("dashboard.output.rate")}
              value={`${formatPacketRate(output.sentRate).value} pps`}
            />
            <Metric
              label={t("dashboard.output.errors")}
              value={formatCount(output.sendErrors)}
              alert={output.sendErrors > 0}
            />
            <Metric
              label={t("dashboard.output.dropped")}
              value={formatCount(output.dropped)}
            />
          </dl>

          <div className="min-w-0 text-sm">
            <span className="text-xs text-muted-foreground">
              {t("dashboard.output.lastError")}
            </span>{" "}
            {output.lastError ? (
              <span className="text-destructive" title={output.lastError}>
                <span className="inline-block max-w-[24rem] truncate align-bottom">
                  {output.lastError}
                </span>{" "}
                <span className="text-xs text-muted-foreground">
                  {t("dashboard.output.ago", {
                    time: formatDuration(ageNow(output.lastErrorAgoMs, receivedAt, now) ?? 0),
                  })}
                </span>
              </span>
            ) : (
              <span className="text-muted-foreground">{t("dashboard.output.none")}</span>
            )}
          </div>
        </div>
      )}
    </SurfacePanel>
  );
}

function Metric({ label, value, alert }: { label: string; value: string; alert?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={alert ? "tabular font-medium text-destructive" : "tabular font-medium"}>
        {value}
      </dd>
    </div>
  );
}

/**
 * 仪表盘输出健康条：订阅 `engine:output`，每秒刷新一次“是否过期”与“距今多久”。
 */
export function OutputHealthStrip() {
  const output = useOutputStore((s) => s.output);
  const receivedAt = useOutputStore((s) => s.receivedAt);
  const now = useNow(1000);
  return <OutputHealthView output={output} receivedAt={receivedAt} now={now} />;
}
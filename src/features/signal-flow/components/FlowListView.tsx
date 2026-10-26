import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { ConflictBadge } from "@/shared/components/ConflictBadge";
import { StatusPill } from "@/shared/components/StatusPill";
import { SurfacePanel } from "@/shared/components/SurfacePanel";
import { formatPacketRate } from "@/shared/lib/format";
import type { DestinationRow, FlowList, RowSource, UniverseRow } from "../lib/listModel";

interface FlowListViewProps {
  list: FlowList;
  /** 是否显示协议（sACN 关闭时只可能是 Art-Net，没有信息量）。 */
  showProtocol: boolean;
  /** 回放节目名；回放伪源用它作展示名。 */
  playerName: string;
}

const TH = "px-3 py-2 text-left text-xs font-medium text-muted-foreground";
const TD = "px-3 py-2 align-top";

function Pps({ value }: { value: number }) {
  return <span className="tabular">{formatPacketRate(value).value} pps</span>;
}

/** 状态列：图标 + 文字，不只靠颜色。 */
function SignalPill({ active, off }: { active: boolean; off?: boolean }) {
  const { t } = useTranslation();
  if (off) return <StatusPill tone="idle">{t("signalFlow.list.off")}</StatusPill>;
  return active ? (
    <StatusPill tone="ready">{t("signalFlow.list.signal")}</StatusPill>
  ) : (
    <StatusPill tone="idle">{t("signalFlow.list.noSignal")}</StatusPill>
  );
}

function SourceCell({ source, playerName, rate }: { source: RowSource; playerName: string; rate: boolean }) {
  const { t } = useTranslation();
  const name = source.isPlayer ? playerName || t("signalFlow.node.player") : source.ip;
  return (
    <li className="flex items-baseline gap-2">
      <span className="tabular">{name}</span>
      {rate && <span className="text-xs text-muted-foreground"><Pps value={source.packetRate} /></span>}
      {!source.active && (
        <span className="text-xs text-muted-foreground">{t("signalFlow.list.noSignal")}</span>
      )}
    </li>
  );
}

function UniverseTable({ rows, showProtocol, playerName }: { rows: UniverseRow[]; showProtocol: boolean; playerName: string }) {
  const { t } = useTranslation();
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">{t("signalFlow.list.pathsCaption")}</caption>
      <thead>
        <tr className="border-b border-border">
          <th scope="col" className={TH}>{t("signalFlow.list.colStatus")}</th>
          <th scope="col" className={TH}>Universe</th>
          <th scope="col" className={TH}>{t("signalFlow.list.colSources")}</th>
          <th scope="col" className={`${TH} text-right`}>{t("dashboard.packetRate")}</th>
          <th scope="col" className={`${TH} text-right`}>{t("dashboard.activeChannels")}</th>
          <th scope="col" className={TH}>{t("signalFlow.list.colDestinations")}</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {rows.map((r) => (
          <tr key={r.universe}>
            <td className={TD}><SignalPill active={r.active} /></td>
            <th scope="row" className={`${TD} text-left font-medium`}>
              <span className="tabular">{t("dashboard.universeN", { n: r.universe })}</span>
              {showProtocol && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {t(`signalFlow.protocol.${r.protocol}`)}
                </span>
              )}
              {r.conflict !== "none" && (
                <div className="mt-1 font-normal">
                  <ConflictBadge level={r.conflict} channels={r.conflictChannels} />
                </div>
              )}
            </th>
            <td className={TD}>
              <ul>
                {r.sources.map((s) => (
                  <SourceCell key={s.ip} source={s} playerName={playerName} rate={r.sources.length > 1} />
                ))}
              </ul>
            </td>
            <td className={`${TD} text-right`}><Pps value={r.packetRate} /></td>
            <td className={`${TD} tabular text-right`}>{r.activeChannels}</td>
            <td className={TD}>
              {r.destinations.length === 0 ? (
                <span className="text-muted-foreground">—</span>
              ) : (
                <ul>
                  {r.destinations.map((d) => (
                    <li key={d.id} className="flex items-center gap-1.5">
                      <span>{d.name || "—"}</span>
                      {!d.enabled && <Badge variant="destructive">{t("signalFlow.node.off")}</Badge>}
                    </li>
                  ))}
                </ul>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DestinationTable({ rows, showProtocol }: { rows: DestinationRow[]; showProtocol: boolean }) {
  const { t } = useTranslation();
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">{t("signalFlow.list.destinationsCaption")}</caption>
      <thead>
        <tr className="border-b border-border">
          <th scope="col" className={TH}>{t("signalFlow.list.colStatus")}</th>
          <th scope="col" className={TH}>{t("forwarding.name")}</th>
          <th scope="col" className={TH}>{t("signalFlow.list.colAddress")}</th>
          <th scope="col" className={TH}>{t("forwarding.mode")}</th>
          <th scope="col" className={`${TH} text-right`}>{t("forwarding.universeOffset")}</th>
          <th scope="col" className={`${TH} text-right`}>{t("forwarding.delay")}</th>
          <th scope="col" className={`${TH} text-right`}>{t("forwarding.stats.sent")}</th>
          <th scope="col" className={`${TH} text-right`}>{t("signalFlow.list.colUniverses")}</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {rows.map((d) => (
          <tr key={d.id}>
            <td className={TD}><SignalPill active={d.active} off={!d.enabled} /></td>
            <th scope="row" className={`${TD} text-left font-medium`}>{d.name || "—"}</th>
            <td className={`${TD} tabular`}>
              {showProtocol && (
                <span className="mr-1 text-xs text-muted-foreground">
                  {d.protocol === "sacn" ? "sACN" : "Art-Net"}
                </span>
              )}
              {d.ip}:{d.port}
            </td>
            <td className={TD}>
              {d.mode === "all" ? t("forwarding.modeAll") : t("forwarding.modeSelected")}
            </td>
            <td className={`${TD} tabular text-right`}>
              {d.universeOffset > 0 ? `+${d.universeOffset}` : d.universeOffset}
            </td>
            <td className={`${TD} tabular text-right`}>{d.delayMs > 0 ? `${d.delayMs}ms` : "—"}</td>
            <td className={`${TD} text-right`}>
              {d.enabled ? <Pps value={d.sentRate} /> : <span className="text-muted-foreground">—</span>}
            </td>
            <td className={`${TD} tabular text-right`}>{d.universeCount}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 滚动容器：可聚焦，键盘用户能用方向键滚动长表格。 */
function Scroll({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className="overflow-x-auto rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </div>
  );
}

/**
 * 信号流的列表视图：节点图的无障碍替代。
 *
 * 一张“Universe 路径”表（来源 → Universe → 目的地，逐行列出，不聚合），
 * 一张“目的地”表（地址、模式、偏移、延迟、发送速率）。状态用图标加文字表达。
 */
export function FlowListView({ list, showProtocol, playerName }: FlowListViewProps) {
  const { t } = useTranslation();
  return (
    <div className="h-full space-y-5 overflow-y-auto p-1">
      <SurfacePanel title={t("signalFlow.list.pathsTitle")}>
        {list.rows.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            {t("dashboard.noActiveUniverses")}
          </p>
        ) : (
          <Scroll label={t("signalFlow.list.pathsTitle")}>
            <UniverseTable rows={list.rows} showProtocol={showProtocol} playerName={playerName} />
          </Scroll>
        )}
      </SurfacePanel>
      <SurfacePanel title={t("signalFlow.list.destinationsTitle")}>
        {list.destinations.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            {t("forwarding.noDestinations")}
          </p>
        ) : (
          <Scroll label={t("signalFlow.list.destinationsTitle")}>
            <DestinationTable rows={list.destinations} showProtocol={showProtocol} />
          </Scroll>
        )}
      </SurfacePanel>
    </div>
  );
}
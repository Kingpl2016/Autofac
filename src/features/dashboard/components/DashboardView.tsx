import { useTranslation } from "react-i18next";
import {
  Activity,
  Radar,
  Forward,
  Gauge,
  Clock,
  MemoryStick,
} from "lucide-react";

import { PageHeader } from "@/shared/components/PageHeader";
import { useEngineDataStore } from "@/shared/stores/engineDataStore";
import { useForwardingQuery } from "@/features/forwarding";
import { StatCard } from "./StatCard";
import { ActiveUniverseList } from "./ActiveUniverseList";
import { OutputHealthStrip } from "./OutputHealthStrip";
import { countDestinations, countDevices } from "../lib/counts";
import { formatPacketRate } from "@/shared/lib/format";
import { formatUptime } from "@/shared/lib/uptime";
import { formatMemory } from "../lib/format";

/**
 * 仪表盘：6 张统计卡 + 输出健康条 + 活跃 Universe。系统日志见底部状态条。
 */
export function DashboardView() {
  const { t } = useTranslation();
  const stats = useEngineDataStore((s) => s.stats);
  const universes = useEngineDataStore((s) => s.universes);
  const devices = useEngineDataStore((s) => s.devices);
  const forwarding = useForwardingQuery();
  const rate = formatPacketRate(stats.packetRate);
  const memory = formatMemory(stats.memoryBytes);
  const deviceCounts = countDevices(devices);
  // 转发表尚未加载或加载失败时显示“—”，不把未知当成 0
  const destCounts = forwarding.data
    ? countDestinations(forwarding.data.destinations)
    : null;

  return (
    <div>
      <PageHeader title={t("dashboard.title")} subtitle={t("dashboard.subtitle")} />

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 2xl:grid-cols-6">
        <StatCard
          label={t("dashboard.activeUniverses")}
          value={String(stats.activeUniverses || universes.length)}
          icon={Activity}
        />
        <StatCard
          label={t("dashboard.discoveredDevices")}
          value={String(deviceCounts.online)}
          hint={
            deviceCounts.total > deviceCounts.online
              ? t("dashboard.hint.devicesTotal", { count: deviceCounts.total })
              : undefined
          }
          icon={Radar}
        />
        <StatCard
          label={t("dashboard.destinations")}
          value={destCounts ? String(destCounts.total) : "—"}
          hint={
            destCounts && destCounts.total > 0
              ? t("dashboard.hint.destinationsEnabled", { count: destCounts.enabled })
              : undefined
          }
          icon={Forward}
        />
        <StatCard
          label={t("dashboard.packetRate")}
          value={rate.value}
          unit={rate.unit}
          icon={Gauge}
        />
        <StatCard
          label={t("dashboard.uptime")}
          value={formatUptime(stats.uptimeSec)}
          icon={Clock}
        />
        <StatCard
          label={t("dashboard.memoryUsage")}
          value={memory.value}
          unit={memory.unit}
          icon={MemoryStick}
        />
      </div>

      <div className="mt-5">
        <OutputHealthStrip />
      </div>

      <div className="mt-5">
        <ActiveUniverseList />
      </div>
    </div>
  );
}
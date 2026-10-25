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
import { StatCard } from "./StatCard";
import { ActiveUniverseList } from "./ActiveUniverseList";
import { SystemLogCard } from "./SystemLogCard";
import { ClusterStatusCard } from "./ClusterStatusCard";
import { formatUptime } from "../lib/format";

/**
 * 仪表盘：统计卡 + 活跃 Universe 列表 + 系统日志 + 集群状态。
 */
export function DashboardView() {
  const { t } = useTranslation();
  const stats = useEngineDataStore((s) => s.stats);
  const universes = useEngineDataStore((s) => s.universes);

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
          value="—"
          icon={Radar}
        />
        <StatCard label={t("dashboard.destinations")} value="—" icon={Forward} />
        <StatCard
          label={t("dashboard.packetRate")}
          value={String(stats.packetRate)}
          icon={Gauge}
        />
        <StatCard
          label={t("dashboard.uptime")}
          value={formatUptime(stats.uptimeSec)}
          icon={Clock}
        />
        <StatCard
          label={t("dashboard.memoryUsage")}
          value="—"
          icon={MemoryStick}
        />
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <ActiveUniverseList />
        </div>
        <div className="grid gap-5">
          <ClusterStatusCard />
        </div>
      </div>

      <div className="mt-5">
        <SystemLogCard />
      </div>
    </div>
  );
}

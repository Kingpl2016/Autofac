import { Server, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";

/** 顶栏的集群角色徽章（主 / 备）。单机运行时不显示。 */
export function ClusterBadge() {
  const clusterRole = useEngineStatusStore((s) => s.clusterRole);
  if (clusterRole === "none") return null;
  return (
    <Badge variant={clusterRole === "primary" ? "success" : "secondary"}>
      <Server className="size-3" aria-hidden />
      {clusterRole.toUpperCase()}
    </Badge>
  );
}

/** 顶栏的 Guardian 守护徽章。未启用时不显示。 */
export function GuardianBadge() {
  const { t } = useTranslation();
  const guardianEnabled = useEngineStatusStore((s) => s.guardianEnabled);
  if (!guardianEnabled) return null;
  return (
    <Badge variant="warning">
      <ShieldCheck className="size-3" aria-hidden />
      {t("header.guardian")}
    </Badge>
  );
}

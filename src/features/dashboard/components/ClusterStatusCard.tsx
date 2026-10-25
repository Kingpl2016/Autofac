import { useTranslation } from "react-i18next";
import { Server } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * 集群状态卡（占位）：集群/冗余功能将在 T18 实现。
 */
export function ClusterStatusCard() {
  const { t } = useTranslation();
  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="p-5 pb-3">
        <CardTitle className="text-base">{t("dashboard.clusterStatus")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col items-center justify-center gap-2 px-5 pb-5 text-muted-foreground">
        <Server className="size-6" aria-hidden />
        <span className="text-sm">{t("placeholder.comingSoon")}</span>
      </CardContent>
    </Card>
  );
}

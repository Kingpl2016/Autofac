import { useTranslation } from "react-i18next";
import { AlertTriangle, Info } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { ConflictLevel } from "@/shared/lib/conflict";

interface ConflictBadgeProps {
  /** 冲突级别；`none` 时不渲染。 */
  level: ConflictLevel;
  /** 取值不一致的通道数。 */
  channels: number;
}

/**
 * 合并冲突徽标：警告级（LTP / Priority）用黄色，提示级（HTP）用中性色；
 * 级别同时体现在图标与文字上，不只靠颜色区分。
 */
export function ConflictBadge({ level, channels }: ConflictBadgeProps) {
  const { t } = useTranslation();
  if (level === "none") return null;
  const warning = level === "warning";
  return (
    <Badge variant={warning ? "warning" : "secondary"}>
      {warning ? (
        <AlertTriangle className="size-3" aria-hidden />
      ) : (
        <Info className="size-3" aria-hidden />
      )}
      {channels} {t("universes.mergeConflictChannels")}
    </Badge>
  );
}
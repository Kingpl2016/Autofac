import {
  Boxes,
  Monitor,
  Router,
  Waypoints,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import type { DeviceCategory } from "@/shared/domain/device";

/** 每个类别的图标与文案键。 */
const CATEGORY_META: Record<
  DeviceCategory,
  { icon: LucideIcon; labelKey: string }
> = {
  artNet: { icon: Waypoints, labelKey: "discovery.filterArtNet" },
  sacn: { icon: Zap, labelKey: "discovery.filterSacn" },
  cluster: { icon: Boxes, labelKey: "discovery.filterCluster" },
  computer: { icon: Monitor, labelKey: "discovery.filterComputer" },
  network: { icon: Router, labelKey: "discovery.filterNetwork" },
};

interface CategoryBadgeProps {
  category: DeviceCategory;
}

/**
 * 设备类别徽标：图标 + 文字。Art-Net 用主色，其余用次要色，便于一眼区分。
 */
export function CategoryBadge({ category }: CategoryBadgeProps) {
  const { t } = useTranslation();
  const { icon: Icon, labelKey } = CATEGORY_META[category];
  return (
    <Badge variant={category === "artNet" ? "default" : "secondary"}>
      <Icon className="size-3.5" aria-hidden />
      {t(labelKey)}
    </Badge>
  );
}

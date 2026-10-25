import { Circle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

interface StatusIndicatorProps {
  online: boolean;
  className?: string;
}

/**
 * 在线状态指示：实心圆点 + “在线”，空心圆环 + “离线”。
 * 形状与文字共同表达状态，不依赖颜色（色盲 / 低对比度环境也能分辨）。
 */
export function StatusIndicator({ online, className }: StatusIndicatorProps) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-sm",
        online ? "text-success" : "text-muted-foreground",
        className,
      )}
    >
      <Circle
        className={cn("size-2.5", online ? "fill-current" : "fill-transparent")}
        strokeWidth={online ? 0 : 2.5}
        aria-hidden
      />
      {online ? t("discovery.online") : t("discovery.offline")}
    </span>
  );
}

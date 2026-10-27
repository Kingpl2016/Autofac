import { useTranslation } from "react-i18next";

import { StatusDot } from "@/shared/components/StatusDot";
import type { LinkState } from "../lib/access";
import { LINK_VISUAL } from "../lib/linkVisual";

interface DeviceStatusBadgeProps {
  state: LinkState;
  /** 只画指示点、文字留给读屏（用于折叠的设备栏） */
  dotOnly?: boolean;
  className?: string;
}

/**
 * 设备连接状态：形状 + 颜色 + 文字（状态不只靠颜色表达）。
 */
export function DeviceStatusBadge({ state, dotOnly, className }: DeviceStatusBadgeProps) {
  const { t } = useTranslation();
  const v = LINK_VISUAL[state];
  if (dotOnly) {
    return (
      <span className={className}>
        <StatusDot tone={v.tone} shape={v.shape} />
        <span className="sr-only">{t(v.label)}</span>
      </span>
    );
  }
  return <StatusDot tone={v.tone} shape={v.shape} label={t(v.label)} className={className} />;
}

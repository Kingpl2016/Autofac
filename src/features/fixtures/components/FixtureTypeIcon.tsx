import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { FixtureType } from "../lib/profile";
import { FIXTURE_TYPE_ICONS } from "../lib/typeIcons";

interface FixtureTypeIconProps {
  type: FixtureType;
  className?: string;
  /** 以 `role="img"` 读出类型名（默认 `true`）；旁边已有类型文字时设为 `false` */
  labelled?: boolean;
}

/**
 * 灯具类型图标（调光 / 白光 / 混色 / 摇头 / 其它）。灯具库、节目编辑器共用。
 */
export function FixtureTypeIcon({ type, className, labelled = true }: FixtureTypeIconProps) {
  const { t } = useTranslation();
  const Icon = FIXTURE_TYPE_ICONS[type];
  if (!labelled) return <Icon aria-hidden className={cn("size-3.5 shrink-0", className)} />;
  const label = t(`fixtures.type.${type}`);
  return (
    <span role="img" aria-label={label} title={label} className="flex shrink-0">
      <Icon aria-hidden className={cn("size-3.5 shrink-0", className)} />
    </span>
  );
}

import {
  Disc3,
  Film,
  GitMerge,
  Keyboard,
  Monitor,
  Network,
  Radio,
  type LucideIcon,
} from "lucide-react";

/** 设置页的分区标识，决定锚点 id 与渲染顺序。 */
export type SettingsSectionId =
  | "network"
  | "protocol"
  | "display"
  | "merge"
  | "recording"
  | "player"
  | "shortcuts";

export interface SettingsSectionMeta {
  /** 分区标识，同时作为 DOM 锚点 id */
  id: SettingsSectionId;
  /** 分区标题的 i18n key */
  titleKey: string;
  /** 分区一句话说明的 i18n key */
  descKey: string;
  /** 分区图标 */
  icon: LucideIcon;
  /**
   * 图标徽章的底色 + 图标色。每个分区取图表色板里的一个色相，让长页面有视觉锚点；
   * 类名必须是完整字面量，Tailwind 才能扫描到。
   */
  tileClass: string;
}

/**
 * 设置页分区的单一事实来源：顺序即渲染顺序。
 */
export const SETTINGS_SECTIONS: readonly SettingsSectionMeta[] = [
  {
    id: "network",
    titleKey: "settings.sectionNetwork",
    descKey: "settings.descNetwork",
    icon: Network,
    tileClass: "bg-chart-2/15 text-chart-2",
  },
  {
    id: "protocol",
    titleKey: "settings.sectionProtocol",
    descKey: "settings.descProtocol",
    icon: Radio,
    tileClass: "bg-chart-1/15 text-chart-1",
  },
  {
    id: "display",
    titleKey: "settings.sectionDisplay",
    descKey: "settings.descDisplay",
    icon: Monitor,
    tileClass: "bg-chart-3/15 text-chart-3",
  },
  {
    id: "merge",
    titleKey: "settings.sectionMerge",
    descKey: "settings.descMerge",
    icon: GitMerge,
    tileClass: "bg-chart-4/15 text-chart-4",
  },
  {
    id: "recording",
    titleKey: "settings.sectionRecording",
    descKey: "settings.descRecording",
    icon: Disc3,
    tileClass: "bg-chart-5/15 text-chart-5",
  },
  {
    id: "player",
    titleKey: "settings.sectionPlayer",
    descKey: "settings.descPlayer",
    icon: Film,
    tileClass: "bg-primary/15 text-primary",
  },
  {
    id: "shortcuts",
    titleKey: "settings.sectionShortcuts",
    descKey: "settings.descShortcuts",
    icon: Keyboard,
    tileClass: "bg-secondary text-secondary-foreground",
  },
] as const;

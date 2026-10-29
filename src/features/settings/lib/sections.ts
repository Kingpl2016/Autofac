import {
  Bug,
  Disc3,
  Film,
  GitMerge,
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
  | "developer";

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
  /**
   * 分区内设置行的标签 / 说明 i18n key，供搜索判断“这个分区里有没有匹配项”。
   * 与 `SettingsForm` 里的行保持一致（有测试保证每个 key 都存在）。
   */
  keywordKeys: readonly string[];
}

/**
 * 设置页分区的单一事实来源：顺序即渲染顺序，也是左侧目录的顺序。
 */
export const SETTINGS_SECTIONS: readonly SettingsSectionMeta[] = [
  {
    id: "network",
    titleKey: "settings.sectionNetwork",
    descKey: "settings.descNetwork",
    icon: Network,
    tileClass: "bg-chart-2/15 text-chart-2",
    keywordKeys: ["settings.networkMode", "settings.interface"],
  },
  {
    id: "protocol",
    titleKey: "settings.sectionProtocol",
    descKey: "settings.descProtocol",
    icon: Radio,
    tileClass: "bg-chart-1/15 text-chart-1",
    keywordKeys: [
      "settings.artnetEnabled",
      "settings.artnetPort",
      "settings.sacnEnabled",
      "settings.sacnPort",
      "settings.sacnUniverses",
    ],
  },
  {
    id: "display",
    titleKey: "settings.sectionDisplay",
    descKey: "settings.descDisplay",
    icon: Monitor,
    tileClass: "bg-chart-3/15 text-chart-3",
    keywordKeys: [
      "settings.uiUpdateRate",
      "settings.universeFormat",
      "settings.channelFormat",
      "settings.valueFormat",
    ],
  },
  {
    id: "merge",
    titleKey: "settings.sectionMerge",
    descKey: "settings.descMerge",
    icon: GitMerge,
    tileClass: "bg-chart-4/15 text-chart-4",
    keywordKeys: ["settings.mergeMode", "settings.sourceTimeout"],
  },
  {
    id: "recording",
    titleKey: "settings.sectionRecording",
    descKey: "settings.descRecording",
    icon: Disc3,
    tileClass: "bg-chart-5/15 text-chart-5",
    keywordKeys: [
      "settings.recordingDir",
      "settings.recordingCompression",
      "settings.recordingZstdLevel",
      "settings.recordingSplitMinutes",
      "settings.recordingGlow",
      "settings.recordingGlowHint",
    ],
  },
  {
    id: "player",
    titleKey: "settings.sectionPlayer",
    descKey: "settings.descPlayer",
    icon: Film,
    tileClass: "bg-primary/15 text-primary",
    keywordKeys: ["settings.startInPlayerMode", "settings.startInPlayerModeHint"],
  },
  // 只在开发构建里渲染（见 `SettingsForm` / `visibleSections`）
  {
    id: "developer",
    titleKey: "settings.sectionDeveloper",
    descKey: "settings.descDeveloper",
    icon: Bug,
    tileClass: "bg-muted text-muted-foreground",
    keywordKeys: [
      "settings.devtools",
      "settings.devtoolsHint",
      "settings.nativeContextMenu",
      "settings.nativeContextMenuHint",
    ],
  },
] as const;

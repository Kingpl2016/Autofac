import {
  LayoutDashboard,
  Grid3x3,
  Radar,
  Forward,
  Workflow,
  Circle,
  Boxes,
  Cable,
  ListVideo,
  Network,
  Info,
  Settings,
  type LucideIcon,
} from "lucide-react";

/** 导航分组键（对应 i18n nav.section*） */
export type NavSection = "signal" | "program" | "network" | "system";

/** 单个导航项 */
export interface NavItem {
  /** 路由路径 */
  to: string;
  /** i18n key（nav.*） */
  labelKey: string;
  /** 图标 */
  icon: LucideIcon;
  /** 所属分组 */
  section: NavSection;
  /** 依赖实时信号：播放器模式下接收已停止，页面里不会有数据（仍可进入以查看原因） */
  liveOnly?: boolean;
}

/**
 * 侧栏导航配置。分组顺序即显示顺序。
 */
export const NAV_ITEMS: NavItem[] = [
  { to: "/", labelKey: "nav.dashboard", icon: LayoutDashboard, section: "signal" },
  { to: "/universes", labelKey: "nav.universes", icon: Grid3x3, section: "signal", liveOnly: true },
  { to: "/discovery", labelKey: "nav.discovery", icon: Radar, section: "signal", liveOnly: true },
  { to: "/forwarding", labelKey: "nav.forwarding", icon: Forward, section: "signal" },
  { to: "/signal-flow", labelKey: "nav.signalFlow", icon: Workflow, section: "signal" },
  { to: "/recording", labelKey: "nav.recording", icon: Circle, section: "program", liveOnly: true },
  { to: "/thing-model", labelKey: "nav.thingModel", icon: Boxes, section: "program" },
  { to: "/loops", labelKey: "nav.loops", icon: Cable, section: "program" },
  { to: "/scenes", labelKey: "nav.scenes", icon: ListVideo, section: "program" },
  { to: "/network", labelKey: "nav.network", icon: Network, section: "network" },
  { to: "/settings", labelKey: "nav.settings", icon: Settings, section: "system" },
  { to: "/about", labelKey: "nav.about", icon: Info, section: "system" },
];

/** 分组顺序 */
export const NAV_SECTIONS: NavSection[] = ["signal", "program", "network", "system"];

/** 分组标题 i18n key */
export const NAV_SECTION_LABELS: Record<NavSection, string> = {
  signal: "nav.sectionSignal",
  program: "nav.sectionProgram",
  network: "nav.sectionNetwork",
  system: "nav.sectionSystem",
};

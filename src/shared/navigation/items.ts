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
  Cpu,
  FolderCog,
  Settings,
  type LucideIcon,
} from "lucide-react";

/** 导航分组键（对应 i18n nav.section*） */
export type NavSection = "signal" | "program" | "device" | "system";

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
}

/**
 * 侧栏导航配置。分组顺序即显示顺序。
 */
export const NAV_ITEMS: NavItem[] = [
  { to: "/", labelKey: "nav.dashboard", icon: LayoutDashboard, section: "signal" },
  { to: "/universes", labelKey: "nav.universes", icon: Grid3x3, section: "signal" },
  { to: "/discovery", labelKey: "nav.discovery", icon: Radar, section: "signal" },
  { to: "/forwarding", labelKey: "nav.forwarding", icon: Forward, section: "signal" },
  { to: "/signal-flow", labelKey: "nav.signalFlow", icon: Workflow, section: "signal" },
  { to: "/recording", labelKey: "nav.recording", icon: Circle, section: "program" },
  { to: "/thing-model", labelKey: "nav.thingModel", icon: Boxes, section: "program" },
  { to: "/loops", labelKey: "nav.loops", icon: Cable, section: "program" },
  { to: "/scenes", labelKey: "nav.scenes", icon: ListVideo, section: "program" },
  { to: "/controller-control", labelKey: "nav.controllerControl", icon: Cpu, section: "device" },
  { to: "/controller-files", labelKey: "nav.controllerFiles", icon: FolderCog, section: "device" },
  { to: "/settings", labelKey: "nav.settings", icon: Settings, section: "system" },
];

/** 分组顺序 */
export const NAV_SECTIONS: NavSection[] = ["signal", "program", "device", "system"];

/** 分组标题 i18n key */
export const NAV_SECTION_LABELS: Record<NavSection, string> = {
  signal: "nav.sectionSignal",
  program: "nav.sectionProgram",
  device: "nav.sectionDevice",
  system: "nav.sectionSystem",
};

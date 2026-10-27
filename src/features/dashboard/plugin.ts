import { LayoutDashboard } from "lucide-react";

import { defineFeaturePlugin, namedExport } from "@/shared/plugin";

/** 仪表盘：根路径页面。 */
export const dashboardPlugin = defineFeaturePlugin({
  name: "dashboard",
  routes: [
    {
      id: "dashboard",
      index: true,
      load: namedExport(() => import("./components/DashboardView"), "DashboardView"),
    },
  ],
  nav: [
    { id: "dashboard", to: "/", end: true, labelKey: "nav.dashboard", icon: LayoutDashboard, section: "signal", order: 10 },
  ],
});

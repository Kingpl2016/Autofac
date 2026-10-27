import { Radar } from "lucide-react";

import { LiveOnly } from "@/features/app-mode";
import { defineFeaturePlugin, namedExport } from "@/shared/plugin";

/** 设备发现：依赖实时信号，播放器模式下由 `LiveOnly` 拦截。 */
export const discoveryPlugin = defineFeaturePlugin({
  name: "discovery",
  routes: [
    {
      id: "discovery",
      path: "discovery",
      guard: LiveOnly,
      load: namedExport(() => import("./components/DiscoveryView"), "DiscoveryView"),
    },
  ],
  nav: [
    { id: "discovery", to: "/discovery", labelKey: "nav.discovery", icon: Radar, section: "signal", order: 30, liveOnly: true },
  ],
});
import { Grid3x3 } from "lucide-react";

import { LiveOnly } from "@/features/app-mode";
import { defineFeaturePlugin, namedExport } from "@/shared/plugin";

/** Universe 视图：依赖实时信号，播放器模式下由 `LiveOnly` 拦截并说明原因。 */
export const universesPlugin = defineFeaturePlugin({
  name: "universes",
  routes: [
    {
      id: "universes",
      path: "universes",
      guard: LiveOnly,
      load: namedExport(() => import("./components/UniversesView"), "UniversesView"),
    },
  ],
  nav: [
    { id: "universes", to: "/universes", labelKey: "nav.universes", icon: Grid3x3, section: "signal", order: 20, liveOnly: true },
  ],
});
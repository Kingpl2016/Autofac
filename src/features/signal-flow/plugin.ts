import { Workflow } from "lucide-react";

import { defineFeaturePlugin, namedExport } from "@/shared/plugin";

/** 信号流（React Flow 等重依赖，按需加载）。 */
export const signalFlowPlugin = defineFeaturePlugin({
  name: "signal-flow",
  routes: [
    {
      id: "signal-flow",
      path: "signal-flow",
      load: namedExport(() => import("./components/SignalFlowView"), "SignalFlowView"),
    },
  ],
  nav: [
    { id: "signal-flow", to: "/signal-flow", labelKey: "nav.signalFlow", icon: Workflow, section: "signal", order: 50 },
  ],
});
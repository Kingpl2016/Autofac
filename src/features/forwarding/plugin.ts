import { Forward } from "lucide-react";

import { defineFeaturePlugin, namedExport } from "@/shared/plugin";

/** 信号转发。 */
export const forwardingPlugin = defineFeaturePlugin({
  name: "forwarding",
  routes: [
    {
      id: "forwarding",
      path: "forwarding",
      load: namedExport(() => import("./components/ForwardingView"), "ForwardingView"),
    },
  ],
  nav: [
    { id: "forwarding", to: "/forwarding", labelKey: "nav.forwarding", icon: Forward, section: "signal", order: 40 },
  ],
});
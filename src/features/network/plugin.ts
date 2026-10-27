import { Network } from "lucide-react";

import { defineFeaturePlugin, namedExport } from "@/shared/plugin";

/** 网络设备。 */
export const networkPlugin = defineFeaturePlugin({
  name: "network",
  routes: [
    {
      id: "network",
      path: "network",
      load: namedExport(() => import("./components/NetworkView"), "NetworkView"),
    },
  ],
  nav: [
    { id: "network", to: "/network", labelKey: "nav.network", icon: Network, section: "network", order: 10 },
  ],
});
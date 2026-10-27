import { Settings } from "lucide-react";

import { defineFeaturePlugin, namedExport } from "@/shared/plugin";

/** 设置。 */
export const settingsPlugin = defineFeaturePlugin({
  name: "settings",
  routes: [
    {
      id: "settings",
      path: "settings",
      load: namedExport(() => import("./components/SettingsView"), "SettingsView"),
    },
  ],
  nav: [
    { id: "settings", to: "/settings", labelKey: "nav.settings", icon: Settings, section: "system", order: 10 },
  ],
});
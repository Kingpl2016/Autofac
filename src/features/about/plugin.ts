import { Info } from "lucide-react";

import { defineFeaturePlugin, namedExport } from "@/shared/plugin";

/** 关于。 */
export const aboutPlugin = defineFeaturePlugin({
  name: "about",
  routes: [
    {
      id: "about",
      path: "about",
      load: namedExport(() => import("./components/AboutView"), "AboutView"),
    },
  ],
  nav: [
    { id: "about", to: "/about", labelKey: "nav.about", icon: Info, section: "system", order: 20 },
  ],
});
import { Boxes } from "lucide-react";

import { defineFeaturePlugin, namedExport } from "@/shared/plugin";

/** 灯具素材库（原“物模型”页，路径保持 /thing-model）。 */
export const fixturesPlugin = defineFeaturePlugin({
  name: "fixtures",
  routes: [
    {
      id: "thing-model",
      path: "thing-model",
      load: namedExport(() => import("./components/FixtureLibraryView"), "FixtureLibraryView"),
    },
  ],
  nav: [
    { id: "thing-model", to: "/thing-model", labelKey: "nav.thingModel", icon: Boxes, section: "program", order: 30 },
  ],
});
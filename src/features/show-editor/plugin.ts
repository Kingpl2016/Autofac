import { Clapperboard } from "lucide-react";

import { defineFeaturePlugin, namedExport } from "@/shared/plugin";

/** 节目编辑器（时间线、拖拽、波形等重依赖，按需加载）；占满内容区，由主布局读取 `handle.fullBleed` 去掉内边距；`playerMode`：进入即进入播放器模式（不确认），离开到普通页面时回到实时模式。 */
export const showEditorPlugin = defineFeaturePlugin({
  name: "show-editor",
  routes: [
    {
      id: "editor",
      path: "editor",
      handle: { fullBleed: true, playerMode: true },
      load: namedExport(() => import("./components/ShowEditorView"), "ShowEditorView"),
    },
  ],
  nav: [
    { id: "editor", to: "/editor", labelKey: "nav.editor", icon: Clapperboard, section: "program", order: 20 },
  ],
});
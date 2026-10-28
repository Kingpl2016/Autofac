import { Clapperboard } from "lucide-react";

import { defineFeaturePlugin, namedExport } from "@/shared/plugin";
import { HeaderHelpSlot } from "./components/HeaderHelpSlot";

/** 节目编辑器（时间轴、拖拽、波形等重依赖，按需加载）；占满内容区，由主布局读取 `handle.fullBleed` 去掉内边距；`playerMode`：进入即进入播放器模式（不确认），离开到普通页面时回到实时模式。 */
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
  // 帮助按钮放在顶栏最右侧（排在个性化 90 之后），所有页面都有；编辑器专属的菜单项只在编辑页显示
  setup: ({ slots }) => slots.register("header.actions", { id: "help", order: 100, component: HeaderHelpSlot }),
});

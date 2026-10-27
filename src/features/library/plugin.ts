import { LibraryBig } from "lucide-react";

import { defineFeaturePlugin, namedExport } from "@/shared/plugin";

/**
 * 节目库插件：独立的节目库页面（表格 + 详情 + 批量操作）与节目编辑导出页（剪辑式时间轴）。
 *
 * 节目的展示与操作复用录制功能导出的组件与 `useProgramActions`，与录制页侧栏的节目库行为一致；
 * 编辑页没有独立导航入口，从节目库的“编辑”进入。两个页面都声明 `playerMode`：进入即进入播放器模式（不确认），
 * 离开到普通页面时自动回到实时模式。
 */
export const libraryPlugin = defineFeaturePlugin({
  name: "library",
  dependsOn: ["recording"],
  routes: [
    {
      id: "library",
      path: "library",
      handle: { playerMode: true },
      load: namedExport(() => import("./components/LibraryView"), "LibraryView"),
    },
    {
      id: "library-edit",
      path: "library/edit",
      handle: { playerMode: true },
      load: namedExport(() => import("./components/edit/ProgramEditView"), "ProgramEditView"),
    },
  ],
  nav: [
    { id: "library", to: "/library", labelKey: "nav.library", icon: LibraryBig, section: "program", order: 15 },
  ],
});

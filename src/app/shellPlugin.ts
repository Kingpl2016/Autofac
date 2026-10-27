import type { AppPlugin } from "@/shared/plugin";

/**
 * 外壳插件：声明侧栏的导航分组。
 * 分组属于应用外壳而不是某个功能，各功能插件只需在 `nav` 里按 id 引用它们。
 */
export const shellPlugin: AppPlugin = {
  name: "shell",
  setup: ({ nav }) => {
    const disposers = [
      nav.sections.register({ id: "signal", labelKey: "nav.sectionSignal", order: 10 }),
      nav.sections.register({ id: "program", labelKey: "nav.sectionProgram", order: 20 }),
      nav.sections.register({ id: "network", labelKey: "nav.sectionNetwork", order: 30 }),
      nav.sections.register({ id: "system", labelKey: "nav.sectionSystem", order: 40 }),
    ];
    return () => {
      for (const dispose of disposers) dispose();
    };
  },
};

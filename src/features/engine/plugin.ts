import type { AppPlugin } from "@/shared/plugin";
import { ClusterBadge, GuardianBadge } from "./components/ClusterBadges";
import { EngineStatus } from "./components/EngineStatus";
import { EngineRuntime } from "./EngineRuntime";

/**
 * 引擎插件：把引擎推送的数据接入全局 store，并在顶栏展示引擎状态。
 * 实时帧由它直接处理；回放帧等其它类别由各自的插件通过 `registerDmxFrameHandler` 登记。
 */
export const enginePlugin: AppPlugin = {
  name: "engine",
  setup: ({ slots }) => {
    const disposers = [
      slots.register("header.status", { id: "engine-status", order: 10, component: EngineStatus }),
      slots.register("header.actions", { id: "cluster-role", order: 40, component: ClusterBadge }),
      slots.register("header.actions", { id: "guardian", order: 50, component: GuardianBadge }),
    ];
    return () => {
      for (const dispose of disposers) dispose();
    };
  },
  Runtime: EngineRuntime,
};

import type {
  ForwardDestination,
  ForwardingTable,
} from "@/features/forwarding/lib/types";
import { fail, type CommandArgs, type DemoModule, type World } from "./world";

/** 转发表里一条生效的路由。 */
export interface Route {
  sourceUniverse: number;
  targetUniverse: number;
  delayMs: number;
}

/**
 * 计算一个目的地对一批 Universe 生效的转发路由。
 *
 * - `all` 模式：转发全部，`exclude` 覆盖项排除；
 * - `selected` 模式：只转发 `forward` 覆盖项列出的；
 * - 目标 Universe 优先取覆盖项的 `targetUniverse`，否则按目的地的 `universeOffset` 平移（不小于 0）；
 * - 延迟优先取覆盖项的 `delayMs`，否则用目的地的 `defaultDelayMs`。
 *
 * # Arguments
 *
 * * `dest` - 转发目的地。
 * * `universes` - 当前有信号的 Universe 编号。
 *
 * # Returns
 *
 * 生效的路由列表；目的地被停用时为空。
 */
export function routesFor(dest: ForwardDestination, universes: readonly number[]): Route[] {
  if (!dest.enabled) return [];
  const routes: Route[] = [];
  for (const u of universes) {
    const override = dest.overrides.find((o) => o.sourceUniverse === u);
    if (override?.action === "exclude") continue;
    if (dest.mode === "selected" && override?.action !== "forward") continue;
    routes.push({
      sourceUniverse: u,
      targetUniverse: Math.max(0, override?.targetUniverse ?? u + dest.universeOffset),
      delayMs: override?.delayMs ?? dest.defaultDelayMs,
    });
  }
  return routes;
}

/** 转发模块：对外多提供一个读取当前转发表的入口。 */
export interface ForwardingModule extends DemoModule {
  /** 当前转发表。 */
  table(): ForwardingTable;
}

/**
 * 创建转发表模块；保存后内存里立即生效，刷新页面后还原为数据文件里的初始表。
 *
 * # Arguments
 *
 * * `world` - 共享的演示世界。
 *
 * # Returns
 *
 * 转发模块。
 */
export function createForwardingModule(world: World): ForwardingModule {
  let current: ForwardingTable = world.data.forwarding;

  return {
    table: () => current,
    commands: {
      get_forwarding: () => current,

      save_forwarding: (args: CommandArgs) => {
        const table = args.table as ForwardingTable | undefined;
        if (!table || !Array.isArray(table.destinations)) fail("invalid_forwarding_table");
        current = table;
        const enabled = table.destinations.filter((d) => d.enabled).length;
        world.log("info", `转发表已保存: ${table.destinations.length} 个目的地 (${enabled} 个启用)`);
      },
    },
  };
}

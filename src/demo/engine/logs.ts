import { useLogStore, type LogEntry } from "@/shared/stores/logStore";
import { hash01, hashText } from "../lib/random";
import type { DemoModule, World } from "./world";

/**
 * 创建系统日志模块：启动时一次性灌入一段“已经运行了几个小时”的历史日志，
 * 之后按 `logs.json` 里的周期模板陆续追加新日志。
 *
 * 历史日志用负数 id，避免和日志 store 之后自增的 id 冲突（界面只把 id 当 key 用）。
 *
 * # Arguments
 *
 * * `world` - 共享的演示世界。
 *
 * # Returns
 *
 * 日志模块（没有命令，只有周期驱动）。
 */
export function createLogsModule(world: World): DemoModule {
  const { history, periodic } = world.data.logs;
  const now = Date.now();

  // 与数据文件里的书写顺序无关，一律按“从早到晚”排好
  const ordered = [...history].sort((a, b) => b.agoSec - a.agoSec);
  const entries: LogEntry[] = ordered.map((h, i) => ({
    id: i - ordered.length,
    level: h.level,
    ts: now - h.agoSec * 1000,
    message: h.message,
  }));
  useLogStore.setState({ entries });

  // 每条模板首次触发的时间错开，避免一启动就同时冒出一排
  const nextAt = periodic.map((p) => p.everySec * 1000 * (0.2 + 0.8 * hash01(hashText(p.message))));

  return {
    commands: {},
    tick: ({ elapsedMs }) => {
      periodic.forEach((p, i) => {
        if (elapsedMs < nextAt[i]) return;
        nextAt[i] += p.everySec * 1000;
        world.log(p.level, p.message);
      });
    },
  };
}

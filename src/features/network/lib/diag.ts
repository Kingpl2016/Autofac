import type { Diag, TaskDiag } from "./types";

/** 保留的采样点数量。 */
export const HISTORY_LEN = 60;

/** 栈剩余低于该字节数标为危险。 */
export const STACK_DANGER_BYTES = 1024;
/** 栈剩余低于该字节数标为偏低。 */
export const STACK_LOW_BYTES = 2048;

/** 一次诊断采样（用于迷你折线）。 */
export interface DiagSample {
  /** 采样时间（毫秒时间戳） */
  at: number;
  heapFree: number;
  /** 非空闲任务的 CPU 占比合计（千分数） */
  cpuPermille: number;
}

/**
 * 把一次诊断结果压缩成采样点。
 *
 * # Arguments
 *
 * * `diag` - 设备返回的诊断。
 * * `at` - 采样时间。
 *
 * # Returns
 *
 * 堆空闲与忙碌 CPU（不含 IDLE 任务）。
 */
export function toSample(diag: Diag, at: number): DiagSample {
  const busy = diag.tasks
    .filter((t) => !/^IDLE/i.test(t.name))
    .reduce((sum, t) => sum + (t.cpuPermille ?? 0), 0);
  return { at, heapFree: diag.heap.free, cpuPermille: Math.min(1000, busy) };
}

/**
 * 追加采样并截断到固定长度（返回新数组）。
 *
 * # Arguments
 *
 * * `history` - 已有采样。
 * * `sample` - 新采样。
 * * `max` - 最多保留条数。
 */
export function pushSample(history: readonly DiagSample[], sample: DiagSample, max = HISTORY_LEN): DiagSample[] {
  const next = [...history, sample];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** 栈余量等级。 */
export type StackLevel = "danger" | "low" | "ok";

/**
 * 栈余量等级（余量越小越危险）。
 *
 * # Arguments
 *
 * * `stackMin` - 任务运行以来的最小剩余栈字节。
 */
export function stackLevel(stackMin: number): StackLevel {
  if (stackMin < STACK_DANGER_BYTES) return "danger";
  if (stackMin < STACK_LOW_BYTES) return "low";
  return "ok";
}

/**
 * 按栈余量升序排序（最危险的在前），余量相同按 CPU 占比降序。返回新数组。
 *
 * # Arguments
 *
 * * `tasks` - 任务列表。
 */
export function sortTasks(tasks: readonly TaskDiag[]): TaskDiag[] {
  return [...tasks].sort(
    (a, b) => a.stackMin - b.stackMin || (b.cpuPermille ?? 0) - (a.cpuPermille ?? 0),
  );
}

/**
 * 堆碎片程度：最大可分配块 / 当前空闲。越接近 1 越完整，越小越碎。
 *
 * # Arguments
 *
 * * `free` - 当前空闲字节。
 * * `largest` - 最大可分配块字节。
 *
 * # Returns
 *
 * 0~1 的比值；空闲为 0 时返回 1（无碎片可言）。
 */
export function heapContiguity(free: number, largest: number): number {
  if (free <= 0) return 1;
  return Math.max(0, Math.min(1, largest / free));
}

/**
 * 生成折线的 SVG 点串。
 *
 * # Arguments
 *
 * * `values` - 数据序列（至少 2 个点才有线）。
 * * `width` - 画布宽。
 * * `height` - 画布高。
 * * `min` - 纵轴下限；省略取数据最小值。
 * * `max` - 纵轴上限；省略取数据最大值。
 *
 * # Returns
 *
 * `points` 属性字符串；少于 2 个点返回空串。
 */
export function sparkPoints(
  values: readonly number[],
  width: number,
  height: number,
  min?: number,
  max?: number,
): string {
  if (values.length < 2) return "";
  const lo = min ?? Math.min(...values);
  const hi = max ?? Math.max(...values);
  const span = hi - lo || 1;
  const step = width / (values.length - 1);
  return values
    .map((v, i) => {
      const y = height - ((v - lo) / span) * height;
      return `${(i * step).toFixed(1)},${Math.max(0, Math.min(height, y)).toFixed(1)}`;
    })
    .join(" ");
}

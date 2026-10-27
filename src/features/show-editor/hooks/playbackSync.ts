import type { Syncer } from "../lib/syncer";
import type { ShowProject } from "../lib/project";

/**
 * 当前挂载的“工程 → 后端”同步器（编辑器页面挂载期间存在）。
 * 播放前需要等待它把最新工程送达，所以以模块级单例暴露。
 */
let active: Syncer<ShowProject> | null = null;

/**
 * 登记 / 注销当前的同步器。
 *
 * @param syncer 同步器；`null` 表示注销。
 */
export function setActiveSyncer(syncer: Syncer<ShowProject> | null): void {
  active = syncer;
}

/**
 * 等待待发的工程变更全部送达后端（没有同步器或没有待发值时立即返回）。
 *
 * @returns 送达后 resolve。
 */
export function flushProjectSync(): Promise<void> {
  return active ? active.flush() : Promise.resolve();
}

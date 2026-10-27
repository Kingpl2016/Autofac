import { compileCached } from "../engine/compiledCache";
import type { Engine } from "../engine/engine";
import { DMX_CHANNELS, type ShowProject } from "./project";

/** DMX 求值器：给定时刻与工程内 Universe，返回该 Universe 的 512 字节（含 Gamma、多重配接与通道锁定）。 */
export type DmxEvaluator = (tMs: number, universe: number) => Uint8Array;

/**
 * 为工程创建 DMX 求值器（DMX 通道视图用），与后端输出同一份 WASM 引擎。
 *
 * 引擎未就绪、工程无法编译或该 Universe 没有任何输出时返回全 0。
 *
 * @param project 工程。
 * @param engine WASM 引擎。
 * @returns 求值函数（每次调用返回新数组）。
 */
export function createDmxEvaluator(project: ShowProject, engine: Engine | null): DmxEvaluator {
  const compiled = compileCached(engine, project);
  return (tMs, universe) => {
    if (!compiled) return new Uint8Array(DMX_CHANNELS);
    const index = compiled.universes.indexOf(universe);
    if (index < 0) return new Uint8Array(DMX_CHANNELS);
    compiled.previewAt(tMs);
    return compiled.frame(index) ?? new Uint8Array(DMX_CHANNELS);
  };
}

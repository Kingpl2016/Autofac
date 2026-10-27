import type { ShowProject } from "../lib/project";
import type { CompiledShow, Engine } from "./engine";

/**
 * 按工程快照缓存编译结果：预览区、DMX 通道视图、时间线色带都要同一个工程的编译结果，
 * 工程是不可变快照（immer），所以用 `WeakMap` 以快照为键，工程被替换后旧结果随之回收。
 */
const cache = new WeakMap<Engine, WeakMap<ShowProject, CompiledShow | null>>();

/**
 * 取得（或编译）工程的编译结果。
 *
 * @param engine WASM 引擎；`null` 时返回 `null`。
 * @param project 工程快照。
 * @returns 编译结果；引擎未就绪或工程无法编译时为 `null`。
 */
export function compileCached(engine: Engine | null, project: ShowProject): CompiledShow | null {
  if (!engine) return null;
  let byProject = cache.get(engine);
  if (!byProject) {
    byProject = new WeakMap();
    cache.set(engine, byProject);
  }
  const hit = byProject.get(project);
  if (hit !== undefined && (hit === null || hit.alive)) return hit;
  const compiled = engine.compile(project);
  byProject.set(project, compiled);
  return compiled;
}

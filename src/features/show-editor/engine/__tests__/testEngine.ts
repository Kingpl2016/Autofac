import { readFileSync } from "node:fs";
import path from "node:path";

import { getEngine, initEngine, type Engine } from "../engine";

/**
 * 测试用：从磁盘同步加载 WASM 引擎（Node 允许同步编译任意大小的模块）。
 * 多次调用复用同一个实例。
 *
 * @returns 已初始化的引擎。
 */
export function loadTestEngine(): Engine {
  const existing = getEngine();
  if (existing) return existing;
  const file = path.resolve(__dirname, "..", "show_engine.wasm");
  return initEngine(new WebAssembly.Module(readFileSync(file)));
}

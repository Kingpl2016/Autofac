import { useEffect, useSyncExternalStore } from "react";

import { getEngine, loadEngine, subscribeEngine, type Engine } from "./engine";

/**
 * 取得 WASM 引擎；尚未就绪时触发加载并返回 `null`，就绪后组件自动重绘。
 *
 * @returns 引擎或 `null`。
 */
export function useEngine(): Engine | null {
  const engine = useSyncExternalStore(subscribeEngine, getEngine, getEngine);
  useEffect(() => {
    if (!engine) {
      loadEngine().catch((e: unknown) => console.error("show-engine WASM 加载失败", e));
    }
  }, [engine]);
  return engine;
}

/// <reference types="vitest/config" />
import { defineConfig, type UserConfig } from "vite";

import viteConfig from "./vite.config";

/**
 * AI 一致性评测（`npm run ai:eval`）：真实调用模型，只收集 `*.eval.ts`，串行运行、超时放宽。
 * 配置与 Key 见 `src/features/show-editor/ai/eval/__tests__/live.eval.ts`。
 */
export default defineConfig((env) => {
  const base = (typeof viteConfig === "function" ? viteConfig(env) : viteConfig) as UserConfig;
  // 不用 mergeConfig：它会把 include 数组拼接起来，这里要替换
  return {
    ...base,
    test: { ...base.test, include: ["src/**/*.eval.ts"], environment: "node", testTimeout: 30 * 60_000, fileParallelism: false },
  };
});

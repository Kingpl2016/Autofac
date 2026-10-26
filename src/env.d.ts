/// <reference types="vite/client" />

/**
 * 构建期常量：是否为演示模式（`vite --mode demo` 或 `VITE_DEMO_MODE=1`）。
 * 由 vite.config.ts 的 `define` 注入；为 `false` 时 `src/demo` 不会进入产物。
 */
declare const __DEMO_MODE__: boolean;

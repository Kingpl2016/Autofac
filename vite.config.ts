/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// Tauri 开发时固定端口；构建目标按 Tauri 平台约定
const host = process.env.TAURI_DEV_HOST;

// https://vitejs.dev/config/
export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "./src"),
      },
    },
    build: {
      // 多页面：主应用 + 信号检测器独立窗口（由 Rust 侧以 signal-checker.html 打开）
      rolldownOptions: {
        input: {
          main: path.resolve(import.meta.dirname, "index.html"),
          "signal-checker": path.resolve(import.meta.dirname, "signal-checker.html"),
        },
      },
    },
    // 只收集前端测试；tools/artnet_sim 的 JS 测试用 node:test 编写，由它自己的脚本运行
    test: {
      include: ["src/**/*.{test,spec}.{ts,tsx}"],
      // 编辑器的集成测试要加载 WASM 引擎，全量并发跑时单个用例偶尔超过默认的 5 秒
      testTimeout: 15_000,
    },
    // Tauri 期望固定端口，失败则直接报错
    clearScreen: false,
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: 1421,
          }
        : undefined,
      watch: {
        // 不监听 Rust 后端目录
        ignored: ["**/src-tauri/**"],
      },
    },
  };
});

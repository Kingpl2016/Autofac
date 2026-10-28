import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// Tauri 开发时固定端口；构建目标按 Tauri 平台约定
const host = process.env.TAURI_DEV_HOST;

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // 演示模式：`vite --mode demo`（npm run dev:demo）或设置环境变量 VITE_DEMO_MODE=1。
  // 以构建期常量 `__DEMO_MODE__` 注入，普通构建里整段演示代码会被摇树移除。
  const demo = mode === "demo" || process.env.VITE_DEMO_MODE === "1";

  return {
    define: {
      __DEMO_MODE__: JSON.stringify(demo),
    },
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

// 把 show-engine 编译成 WebAssembly，供节目编辑器的前端预览使用。
//
// 用法：npm run build:wasm
// 需要 Rust 工具链与 wasm32 目标（rustup target add wasm32-unknown-unknown）。
// 产物复制到 src/features/show-editor/engine/show_engine.wasm 并纳入版本管理，
// 这样只改前端的同学不必安装 Rust；改了 show-engine 之后务必重新运行本脚本
// （TS 黄金向量测试经 WASM 求值，产物过期时会失败）。

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tauri = path.join(root, "src-tauri");

execFileSync(
  "cargo",
  ["build", "-p", "show-engine-wasm", "--target", "wasm32-unknown-unknown", "--profile", "wasm"],
  { cwd: tauri, stdio: "inherit" },
);

const built = path.join(tauri, "target", "wasm32-unknown-unknown", "wasm", "show_engine_wasm.wasm");
const target = path.join(root, "src", "features", "show-editor", "engine", "show_engine.wasm");
mkdirSync(path.dirname(target), { recursive: true });
copyFileSync(built, target);
console.log(`show_engine.wasm → ${path.relative(root, target)} (${Math.round(statSync(target).size / 1024)} KB)`);

// 由 Rust DTO 生成前端 TypeScript 类型（ts-rs），输出到 src/bindings 并纳入版本管理。
//
// 用法：
//   npm run gen:types     重新生成（先清空目录，删掉的 Rust 类型不会留下过期文件）
//   npm run check:types   重新生成后检查 src/bindings 与已提交版本一致（CI / 提交前用）
//
// 各 crate 把 ts-rs 作为可选依赖挂在 `ts` feature 上，带 `ts(export)` 的类型会生成
// `export_bindings_*` 测试；这里用 `--all-features` 打开所有 crate 的 `ts` 并只跑这些测试。
// 输出目录与大整数映射见 src-tauri/.cargo/config.toml 的 `[env]`。

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bindings = path.join(root, "src", "bindings");
const check = process.argv.includes("--check");

rmSync(bindings, { recursive: true, force: true });
execFileSync("cargo", ["test", "--workspace", "--all-features", "export_bindings"], {
  cwd: path.join(root, "src-tauri"),
  stdio: ["ignore", "ignore", "inherit"],
});

if (check) {
  const status = execFileSync("git", ["status", "--porcelain", "--", "src/bindings"], {
    cwd: root,
    encoding: "utf8",
  });
  if (status.trim()) {
    console.error("src/bindings 与 Rust 类型不一致，请运行 npm run gen:types 并提交：\n" + status);
    process.exit(1);
  }
  console.log("src/bindings 已是最新");
} else {
  console.log(`已生成 ${path.relative(root, bindings)}`);
}

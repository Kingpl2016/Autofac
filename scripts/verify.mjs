#!/usr/bin/env node
// 完整校验：先并行跑静态检查（类型、lint、未使用的导出），都通过后再跑测试。
//
//   npm run verify            全部测试
//   npm run verify:changed    只跑与未提交改动相关的测试（vitest --changed）
//
// 提速点：tsc 增量（tsconfig 的 incremental + buildinfo）、eslint 缓存与多线程、三项静态检查并行；
// 静态检查失败时不再跑测试。各项的输出缓存起来，结束后按顺序打印，避免交错。

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = (p) => path.join(root, "node_modules", p);
const changed = process.argv.includes("--changed");

/** 静态检查（并行）。 */
const checks = [
  { name: "tsc", args: [bin("typescript/bin/tsc"), "-b"] },
  {
    name: "eslint",
    args: [bin("eslint/bin/eslint.js"), ".", "--cache", "--cache-location", "node_modules/.cache/eslint/", "--concurrency", "auto"],
  },
  { name: "knip", args: [bin("knip/bin/knip.js")] },
];

/**
 * 运行一个 node 脚本。
 *
 * @param {string[]} args 脚本与参数。
 * @param {boolean} capture 是否缓存输出（否则直接输出到终端）。
 * @returns {Promise<{ code: number; output: string; ms: number }>}
 */
function run(args, capture) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      env: { ...process.env, FORCE_COLOR: process.stdout.isTTY ? "1" : "0" },
    });
    let output = "";
    child.stdout?.on("data", (d) => (output += d));
    child.stderr?.on("data", (d) => (output += d));
    child.on("close", (code) => resolve({ code: code ?? 1, output, ms: Date.now() - started }));
    child.on("error", (e) => resolve({ code: 1, output: String(e), ms: Date.now() - started }));
  });
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

const results = await Promise.all(checks.map((c) => run(c.args, true)));
let failed = false;
results.forEach((r, i) => {
  const ok = r.code === 0;
  failed ||= !ok;
  console.log(`${ok ? "✔" : "✖"} ${checks[i].name} (${seconds(r.ms)})`);
  // 通过的也打印输出（例如 lint 警告），失败的必须打印
  if (r.output.trim()) console.log(r.output.trimEnd());
});
if (failed) {
  console.error("\n静态检查没有通过，跳过测试。");
  process.exit(1);
}

const tests = await run([bin("vitest/vitest.mjs"), "run", "--passWithNoTests", ...(changed ? ["--changed"] : [])], false);
console.log(`${tests.code === 0 ? "✔" : "✖"} vitest${changed ? " --changed" : ""} (${seconds(tests.ms)})`);
process.exit(tests.code);

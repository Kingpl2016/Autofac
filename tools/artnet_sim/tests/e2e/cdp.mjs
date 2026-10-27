// 极简的 Chrome DevTools Protocol 客户端:用无头 Edge/Chrome 驱动真实页面做冒烟测试。
// 只依赖 Node 22 自带的 fetch / WebSocket,不需要安装任何 npm 包。
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CANDIDATES = [
  process.env.BROWSER,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/microsoft-edge",
];

export function findBrowser() {
  return CANDIDATES.find((p) => p && existsSync(p)) || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ width = 1280, height = 900, port = 9333 + Math.floor(Math.random() * 500) } = {}) {
  const exe = findBrowser();
  if (!exe) throw new Error("没有找到 Edge / Chrome");
  const profile = mkdtempSync(join(tmpdir(), "cdp-profile-"));
  const proc = spawn(exe, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    `--window-size=${width},${height}`,
    "about:blank",
  ], { stdio: "ignore" });

  let target = null;
  for (let i = 0; i < 80 && !target; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = list.find((t) => t.type === "page");
    } catch {
      // 浏览器还没起来
    }
    if (!target) await sleep(150);
  }
  if (!target) {
    proc.kill();
    throw new Error("无法连接到浏览器调试端口");
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    } else if (message.method) {
      for (const fn of listeners) fn(message);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const errors = [];
  listeners.push((m) => {
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      errors.push(`JS 异常: ${d.exception?.description || d.text}`);
    } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      errors.push(`console.error: ${m.params.args.map((a) => a.value ?? a.description).join(" ")}`);
    } else if (m.method === "Log.entryAdded" && m.params.entry.level === "error") {
      errors.push(`日志: ${m.params.entry.text} ${m.params.entry.url || ""}`);
    }
  });
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.enable");
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });

  const api = {
    errors,
    send,
    async goto(url) {
      await send("Page.navigate", { url });
      await sleep(400);
    },
    async eval(expression) {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate 失败");
      return result.result.value;
    },
    async waitFor(expression, timeout = 8000, what = expression) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (await api.eval(`Boolean(${expression})`)) return;
        await sleep(100);
      }
      throw new Error(`等待超时: ${what}`);
    },
    async click(selector) {
      await api.waitFor(`document.querySelector(${JSON.stringify(selector)})`, 5000, `元素 ${selector}`);
      await api.eval(`document.querySelector(${JSON.stringify(selector)}).click()`);
    },
    async fill(selector, value) {
      await api.waitFor(`document.querySelector(${JSON.stringify(selector)})`, 5000, `元素 ${selector}`);
      await api.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
        el.value = ${JSON.stringify(String(value))};
        el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); })()`);
    },
    async text(selector = "body") {
      return api.eval(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`);
    },
    async screenshot(path) {
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      const { writeFileSync } = await import("node:fs");
      writeFileSync(path, Buffer.from(data, "base64"));
    },
    sleep,
    async close() {
      try {
        await send("Browser.close");
      } catch {
        // 已经关闭
      }
      ws.close();
      proc.kill();
      await sleep(300);
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {
        // 浏览器可能还占着文件,忽略
      }
    },
  };
  return api;
}

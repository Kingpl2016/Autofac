// 前端冒烟测试:用无头浏览器真实操作每个页面,断言没有 JS 异常。
// 用法:BASE_URL=http://127.0.0.1:8765 node tests/e2e/smoke.mjs [截图目录]
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { launch } from "./cdp.mjs";

const BASE = process.env.BASE_URL || "http://127.0.0.1:8765";
const SHOTS = process.argv[2] || null;
const ARTNET_PORT = Number(process.env.ARTNET_PORT || 6454);
const SACN_PORT = Number(process.env.SACN_PORT || 5568);
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

async function json(method, path, body) {
  const response = await fetch(BASE + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return response.status === 204 ? null : response.json();
}

const browser = await launch();
const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push(`✓ ${name}`);
  } catch (error) {
    results.push(`✗ ${name}: ${error.message}`);
    if (SHOTS) await browser.screenshot(join(SHOTS, `fail-${results.length}.png`)).catch(() => {});
  }
}
/** 点击容器里文字完全匹配的按钮。 */
async function clickButton(scope, text) {
  await browser.waitFor(
    `[...document.querySelector(${JSON.stringify(scope)}).querySelectorAll('button')].some(b => b.innerText.trim() === ${JSON.stringify(text)} && !b.disabled)`,
    8000, `按钮“${text}”`,
  );
  await browser.eval(
    `[...document.querySelector(${JSON.stringify(scope)}).querySelectorAll('button')].find(b => b.innerText.trim() === ${JSON.stringify(text)} && !b.disabled).click()`,
  );
}
const shot = (name) => (SHOTS ? browser.screenshot(join(SHOTS, `${name}.png`)) : Promise.resolve());

try {
  await step("总览页加载并显示状态", async () => {
    await browser.goto(`${BASE}/#/overview`);
    await browser.waitFor(`document.querySelector('#view .card')`);
    await browser.waitFor(`document.body.innerText.includes('已连接')`);
    assert.match(await browser.text("#view"), /运行状态/);
    await shot("overview");
  });

  await step("新建发送源(sACN 正弦波)并出现在列表里", async () => {
    await browser.goto(`${BASE}/#/sources`);
    await browser.click("button.primary");
    await browser.waitFor(`document.querySelector('dialog[open]')`);
    await browser.eval(`(() => { const s = document.querySelector('dialog select[name=protocol]'); s.value = 'sacn'; s.dispatchEvent(new Event('change', {bubbles:true})); })()`);
    await browser.fill("dialog input[name=universes]", "40-42");
    await browser.eval(`(() => { const s = document.querySelector('dialog select[name=generator]'); s.value = 'sine'; s.dispatchEvent(new Event('change', {bubbles:true})); })()`);
    await browser.eval(`(() => { const s = document.querySelector('dialog select[name=target_kind]'); s.value = 'custom'; s.dispatchEvent(new Event('change', {bubbles:true})); })()`);
    await browser.fill("dialog input[name=target_ip]", "127.0.0.1");
    await browser.fill("dialog input[name=port]", String(SACN_PORT));
    await browser.fill("dialog input[name=rate]", "20");
    await browser.fill("dialog input[name=loss]", "10");
    await shot("source-dialog");
    await browser.click("dialog button[type=submit]");
    await browser.waitFor(`!document.querySelector('dialog')`);
    await browser.waitFor(`[...document.querySelectorAll('tbody tr')].some(r => r.innerText.includes('sine'))`);
    const sources = await json("GET", "/api/sources");
    const created = sources.find((s) => s.config.generator === "sine");
    assert.deepEqual(created.config.universes, [40, 41, 42]);
    assert.equal(created.config.protocol, "sacn");
    assert.equal(created.config.impairments.loss, 0.1);
    globalThis.createdId = created.id;
  });

  await step("创建失败时对话框里显示错误且不关闭", async () => {
    await browser.click("button.primary");
    await browser.waitFor(`document.querySelector('dialog[open]')`);
    await browser.fill("dialog input[name=universes]", "99999");
    await browser.click("dialog button[type=submit]");
    await browser.waitFor(`document.querySelector('dialog .error-text')?.innerText.length > 0`);
    assert.ok(await browser.eval(`!!document.querySelector('dialog[open]')`));
    await shot("source-dialog-error");
    await browser.click("dialog button[type=button]");
    await browser.waitFor(`!document.querySelector('dialog')`);
  });

  await step("修改帧率", async () => {
    await browser.eval(`[...document.querySelectorAll('tbody tr')].find(r => r.innerText.includes('sine')).querySelector('button').click()`);
    await browser.waitFor(`document.querySelector('dialog[open]')`);
    assert.equal(await browser.eval(`document.querySelector('dialog input[name=rate]').value`), "20");
    await browser.fill("dialog input[name=rate]", "15");
    await browser.click("dialog button[type=submit]");
    await browser.waitFor(`!document.querySelector('dialog')`);
    const detail = await json("GET", `/api/sources/${globalThis.createdId}`);
    assert.equal(detail.config.rate, 15);
  });

  await step("静默停发/恢复按钮切换", async () => {
    const row = `[...document.querySelectorAll('tbody tr')].find(r => r.innerText.includes('sine'))`;
    await browser.eval(`${row}.querySelectorAll('button')[2].click()`);
    await browser.waitFor(`${row}.innerText.includes('静默停发') && ${row}.innerText.includes('恢复')`);
    await browser.eval(`${row}.querySelectorAll('button')[2].click()`);
    await browser.waitFor(`${row}.innerText.includes('运行中')`);
  });

  await step("通道监看显示数据", async () => {
    await browser.goto(`${BASE}/#/monitor?protocol=sacn&universe=40`);
    await browser.waitFor(`document.querySelector('canvas.dmx')`);
    await json("POST", "/api/capture/sacn-universes", { universes: [40] });
    await browser.waitFor(`Number(document.querySelector('canvas.dmx').dataset.frames) > 3`, 10000, "收到 sACN 通道数据帧");
    assert.ok(await browser.eval(`document.querySelector('.notice.warn').classList.contains('hidden')`));
    const info = await browser.text("#view");
    assert.match(info, /sACN 40/);
    assert.match(info, /活跃/);
    await shot("monitor");
  });

  await step("虚拟节点:创建、下线、删除", async () => {
    await browser.goto(`${BASE}/#/nodes`);
    await browser.click("button.primary");
    await browser.waitFor(`document.querySelector('dialog[open]')`);
    await browser.fill("dialog input[name=short_name]", "e2e-node");
    await browser.fill("dialog input[name=start]", "5");
    await browser.fill("dialog input[name=count]", "2");
    await shot("node-dialog");
    await browser.click("dialog button[type=submit]");
    await browser.waitFor(`!document.querySelector('dialog')`);
    await browser.waitFor(`document.querySelector('.node-card')`);
    assert.match(await browser.text(".node-card"), /e2e-node/);
    assert.equal(await browser.eval(`document.querySelectorAll('.node-card tbody tr').length`), 2);
    const snapshot = await json("GET", "/api/nodes");
    assert.deepEqual(snapshot.nodes[0].ports.map((p) => p.out_address), [5, 6]);
    await shot("nodes");
    await clickButton(".node-card", "下线");
    await browser.waitFor(`document.querySelector('.node-card').innerText.includes('离线')`);
    assert.equal((await json("GET", "/api/nodes")).nodes[0].online, false);
    await clickButton(".node-card", "删除");
    await browser.waitFor(`document.querySelector('dialog[open]')`);
    await browser.click("dialog button.primary");
    await browser.waitFor(`!document.querySelector('.node-card')`);
    assert.equal((await json("GET", "/api/nodes")).nodes.length, 0);
  });

  await step("抓包分析:数据流统计与包日志", async () => {
    await browser.goto(`${BASE}/#/capture`);
    await browser.waitFor(
      `[...document.querySelectorAll('table:not(.hidden) tbody tr')].some(r => r.innerText.includes('sACN') && r.innerText.includes('40'))`,
      12000, "数据流表出现 sACN 40",
    );
    assert.ok(await browser.eval(`!!document.querySelector('canvas.spark')`));
    await browser.fill("#log-uni", "40");
    await browser.click("form.filters button[type=submit]");
    await browser.waitFor(
      `document.querySelectorAll('.log-wrap tbody tr').length > 0 && [...document.querySelectorAll('.log-wrap tbody tr')].every(r => r.children[4].innerText === '40')`,
      10000, "包日志只剩 Universe 40",
    );
    await shot("capture");
    await browser.click(".log-wrap tbody tr button");
    await browser.waitFor(`document.querySelector('dialog[open] table')`);
    assert.match(await browser.text("dialog"), /Universe/);
    await browser.click("dialog button.primary");
    await browser.waitFor(`!document.querySelector('dialog')`);
  });

  await step("录制与回放:录制、下载、回放、删除", async () => {
    await browser.goto(`${BASE}/#/recordings`);
    await browser.fill("#rec-name", "e2e-rec");
    await browser.fill("#rec-uni", "40");
    await browser.eval(`document.querySelector('#rec-artnet').click()`);
    await browser.waitFor(`!document.querySelector('#view .card button.primary').disabled`);
    await browser.click("#view .card button.primary");
    await browser.waitFor(`document.querySelector('#view').innerText.includes('录制中')`);
    await shot("recording");
    await browser.sleep(1500);
    await clickButton("#view", "停止录制");
    await browser.waitFor(`document.querySelector('a[download]')`, 8000, "文件列表出现下载链接");
    assert.match(await browser.text("tbody"), /e2e-rec\.artrec/);
    const files = await json("GET", "/api/recordings");
    assert.ok(files[0].frames > 0, "录到了帧");
    const href = await browser.eval(`document.querySelector('a[download]').getAttribute('href')`);
    const response = await fetch(BASE + href);
    assert.equal(response.status, 200);
    assert.ok((await response.arrayBuffer()).byteLength > 64);
    await shot("recordings");

    await browser.click(`button[aria-label="回放 e2e-rec.artrec"]`);
    await browser.waitFor(`document.querySelector('dialog[open]')`);
    await browser.eval(`(() => { const s = document.querySelector('dialog select[name=protocol]'); s.value = 'sacn'; s.dispatchEvent(new Event('change', {bubbles:true})); })()`);
    await browser.eval(`(() => { const s = document.querySelector('dialog select[name=target_kind]'); s.value = 'custom'; s.dispatchEvent(new Event('change', {bubbles:true})); })()`);
    await browser.fill("dialog input[name=target_ip]", "127.0.0.1");
    await browser.fill("dialog input[name=port]", String(SACN_PORT));
    await browser.click("dialog button[type=submit]");
    await browser.waitFor(`location.hash.startsWith('#/sources')`);
    await browser.waitFor(`[...document.querySelectorAll('tbody tr')].some(r => r.innerText.includes('artrec'))`);
    const replay = (await json("GET", "/api/sources")).find((s) => s.config.generator === "artrec");
    assert.deepEqual(replay.config.universes, [40]);
    await json("DELETE", `/api/sources/${replay.id}`);

    await browser.goto(`${BASE}/#/recordings`);
    await browser.click(`button[aria-label="删除 e2e-rec.artrec"]`);
    await browser.waitFor(`document.querySelector('dialog[open]')`);
    await browser.click("dialog button.primary");
    await browser.waitFor(`!document.querySelector('a[download]')`);
    assert.equal((await json("GET", "/api/recordings")).length, 0);
  });

  await step("场景:校验并运行自定义 YAML、停止", async () => {
    await browser.goto(`${BASE}/#/scenarios`);
    await browser.waitFor(`[...document.querySelectorAll('button')].some(b => b.innerText === '载入编辑器')`, 8000, "内置场景列表");
    const yaml = [
      "name: e2e 场景",
      "duration: 30",
      "sources:",
      `  - {id: sc-src, protocol: sacn, universes: 61, rate: 20, target: 127.0.0.1, port: ${SACN_PORT}}`,
      "timeline:",
      "  - {at: 0.3, action: log, message: e2e-hello}",
      "",
    ].join("\n");
    await browser.fill("#sc-yaml", yaml);
    await clickButton("#view", "校验");
    await browser.waitFor(`document.querySelector('.notice.ok')?.innerText.includes('校验通过')`);
    await browser.fill("#sc-yaml", "name: 坏\nsources: [{}]");
    await clickButton("#view", "校验");
    await browser.waitFor(`document.querySelector('.error-text')?.innerText.includes('id')`);
    await browser.fill("#sc-yaml", yaml);
    await browser.eval(`[...document.querySelectorAll('button')].filter(b => b.innerText === '运行').pop().click()`);
    await browser.waitFor(`document.querySelector('.scenario-log')?.innerText.includes('e2e-hello')`, 10000, "场景日志");
    assert.match(await browser.text("#view"), /运行中/);
    await shot("scenarios");
    await clickButton("#view", "停止场景");
    await browser.waitFor(`document.querySelector('#view').innerText.includes('已结束')`);
    const status = await json("GET", "/api/scenarios/status");
    assert.equal(status.running, false);
  });

  await step("删除这个发送源", async () => {
    await json("DELETE", `/api/sources/${globalThis.createdId}`);
  });
} finally {
  results.push(...browser.errors.map((e) => `✗ 浏览器错误: ${e}`));
  await browser.close();
}
console.log(results.join("\n"));
process.exit(results.some((r) => r.startsWith("✗")) ? 1 : 0);

// 前端纯函数的单元测试:node --test tests/js
import assert from "node:assert/strict";
import { test } from "node:test";

import { luminance, mix } from "../../src/artnet_sim/web/static/js/dmxgrid.js";
import {
  buildPorts,
  channelIntensity,
  channelName,
  chunk,
  compactRanges,
  fmtBytes,
  fmtDuration,
  fmtMs,
  fmtNumber,
  fmtTimestamp,
  logQuery,
  parseRanges,
  percentToFraction,
  scenarioProgress,
  sparkPoints,
  toInt,
  universeLabel,
} from "../../src/artnet_sim/web/static/js/format.js";
import {
  decodeFrame,
  frameMatches,
  watchKey,
  watchMessage,
} from "../../src/artnet_sim/web/static/js/frames.js";

test("parseRanges 与 Python 端行为一致", () => {
  assert.deepEqual(parseRanges("1-4,8, 10-11,2"), [1, 2, 3, 4, 8, 10, 11]);
  assert.deepEqual(parseRanges("5"), [5]);
  for (const bad of ["", "a", "4-1", "1-", "-3", "1,,x"]) {
    assert.throws(() => parseRanges(bad), /范围|解析|起点/);
  }
  assert.throws(() => parseRanges("0", 1, 10), /超出/);
  assert.throws(() => parseRanges("1-99999999", 0, 1e9), /过大/);
});

test("compactRanges 把数组压成简写", () => {
  assert.equal(compactRanges([1, 2, 3, 4, 8, 10, 11]), "1-4, 8, 10-11");
  assert.equal(compactRanges([5]), "5");
  assert.equal(compactRanges([]), "");
  assert.equal(compactRanges([3, 1, 2]), "1-3");
  assert.equal(compactRanges(parseRanges("0-2,7")), "0-2, 7");
});

test("数字与单位格式化", () => {
  assert.equal(fmtNumber(3.14159, 2), "3.14");
  assert.equal(fmtNumber(NaN), "-");
  assert.equal(fmtNumber("x"), "-");
  assert.equal(fmtMs(1.2345, 1), "1.2 ms");
  assert.equal(fmtMs(undefined), "-");
  assert.equal(fmtDuration(12.34), "12.3 秒");
  assert.equal(fmtDuration(125), "2 分 05 秒");
  assert.equal(fmtDuration(3725), "1 小时 02 分");
  assert.equal(fmtDuration(-1), "-");
  assert.equal(fmtBytes(512), "512 B");
  assert.equal(fmtBytes(2048), "2.0 KiB");
  assert.equal(fmtBytes(3 * 1024 * 1024), "3.0 MiB");
});

test("标签与通道名", () => {
  assert.equal(universeLabel("sacn", 7), "sACN 7");
  assert.equal(universeLabel("artnet", 0), "Art-Net 0");
  assert.equal(channelName(0), "通道 1");
  assert.equal(channelName(511), "通道 512");
});

test("通道亮度:单调且低值可见", () => {
  assert.equal(channelIntensity(0), 0);
  assert.equal(channelIntensity(255), 1);
  assert.ok(channelIntensity(10) > 10 / 255);
  assert.ok(channelIntensity(100) < channelIntensity(101));
  assert.equal(channelIntensity(-5), 0);
  assert.equal(channelIntensity(999), 1);
});

test("chunk 切行", () => {
  assert.deepEqual(chunk(new Uint8Array([1, 2, 3, 4, 5]), 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 4), []);
});

test("输入校验辅助", () => {
  assert.equal(toInt("12", 0, 20), 12);
  assert.equal(toInt("21", 0, 20), null);
  assert.equal(toInt("1.5", 0, 20), null);
  assert.equal(toInt("", 0, 20), null);
  assert.equal(percentToFraction(""), 0);
  assert.equal(percentToFraction("25"), 0.25);
  assert.equal(percentToFraction("101"), null);
  assert.equal(percentToFraction("-1"), null);
  assert.equal(percentToFraction("abc"), null);
});

test("颜色插值与亮度", () => {
  assert.deepEqual(mix([0, 0, 0], [200, 100, 50], 0), [0, 0, 0]);
  assert.deepEqual(mix([0, 0, 0], [200, 100, 50], 1), [200, 100, 50]);
  assert.deepEqual(mix([0, 0, 0], [200, 100, 50], 0.5), [100, 50, 25]);
  assert.ok(luminance([255, 255, 255]) > 0.99);
  assert.equal(luminance([0, 0, 0]), 0);
});

test("decodeFrame 类型 1(Universe)", () => {
  const bytes = new Uint8Array([1, 2, 0x01, 0x02, 9, 8, 7]);
  const frame = decodeFrame(bytes);
  assert.equal(frame.type, 1);
  assert.equal(frame.protocol, "sacn");
  assert.equal(frame.universe, 0x0102);
  assert.deepEqual([...frame.data], [9, 8, 7]);
  // ArrayBuffer 与带偏移的 Uint8Array 也能解
  const padded = new Uint8Array([0, 0, ...bytes]).subarray(2);
  assert.equal(decodeFrame(padded).universe, 0x0102);
  assert.equal(decodeFrame(bytes.buffer).universe, 0x0102);
});

test("decodeFrame 类型 2(节点端口)", () => {
  const id = new TextEncoder().encode("节点-1");
  const bytes = new Uint8Array([2, id.length, ...id, 0, 3, 5, 6]);
  const frame = decodeFrame(bytes);
  assert.equal(frame.type, 2);
  assert.equal(frame.nodeId, "节点-1");
  assert.equal(frame.port, 3);
  assert.deepEqual([...frame.data], [5, 6]);
});

test("decodeFrame 拒绝坏数据", () => {
  assert.equal(decodeFrame(new Uint8Array([1, 1, 0])), null); // 太短
  assert.equal(decodeFrame(new Uint8Array([1, 9, 0, 1, 1])), null); // 未知协议
  assert.equal(decodeFrame(new Uint8Array([9, 1, 0, 1, 1])), null); // 未知类型
  assert.equal(decodeFrame(new Uint8Array([2, 200, 0, 1])), null); // id 长度超出
});

test("监看项的键与匹配", () => {
  const universe = { kind: "universe", protocol: "artnet", universe: 5 };
  const node = { kind: "node", id: "n1", port: 2 };
  assert.equal(watchKey(universe), "universe:artnet:5");
  assert.equal(watchKey(node), "node:n1:2");
  assert.ok(frameMatches({ type: 1, protocol: "artnet", universe: 5 }, universe));
  assert.ok(!frameMatches({ type: 1, protocol: "sacn", universe: 5 }, universe));
  assert.ok(frameMatches({ type: 2, nodeId: "n1", port: 2 }, node));
  assert.ok(!frameMatches({ type: 2, nodeId: "n1", port: 1 }, node));
  assert.ok(!frameMatches(null, node));
  assert.deepEqual(JSON.parse(watchMessage([universe])), { type: "watch", items: [universe] });
});

test("buildPorts 生成连续端口并校验范围", () => {
  const ports = buildPorts({ start: "10", count: "3", direction: "both", mergeMode: "ltp", protocol: "sacn" });
  assert.deepEqual(ports.map((p) => p.address), [10, 11, 12]);
  assert.deepEqual(ports[0], { direction: "both", address: 10, merge_mode: "ltp", protocol: "sacn" });
  assert.equal(buildPorts({ start: 0, count: 1 })[0].direction, "output");
  assert.throws(() => buildPorts({ start: "-1", count: 1 }), /起始/);
  assert.throws(() => buildPorts({ start: 0, count: 0 }), /端口数/);
  assert.throws(() => buildPorts({ start: 0, count: 65 }), /端口数/);
  assert.throws(() => buildPorts({ start: 32767, count: 2 }), /超出/);
});

test("sparkPoints 把序列映射到画布坐标", () => {
  assert.deepEqual(sparkPoints([], 100, 20), []);
  const pts = sparkPoints([0, 10, 5], 104, 24, 1);
  assert.equal(pts.length, 3);
  assert.equal(pts[0][0], 2); // 左边距
  assert.equal(pts[2][0], 102); // 右边距
  assert.ok(pts[1][1] < pts[2][1] && pts[2][1] < pts[0][1]); // 值越大 y 越小
  // 全 0 时不应除零,线贴在底部
  const flat = sparkPoints([0, 0, 0], 100, 20, 1);
  assert.ok(flat.every(([, y]) => y === 18));
  // 单点不应产生 NaN
  assert.ok(sparkPoints([3], 100, 20).every((p) => p.every(Number.isFinite)));
});

test("logQuery 只写入非空条件", () => {
  assert.equal(logQuery({ after: 5, limit: 50 }), "after=5&limit=50");
  assert.equal(
    logQuery({ protocol: "sacn", universe: 0, srcIp: "10.0.0.1" }),
    "after=0&limit=200&protocol=sacn&universe=0&src_ip=10.0.0.1",
  );
  assert.equal(logQuery({ universe: "" }), "after=0&limit=200");
});

test("scenarioProgress 与 fmtTimestamp", () => {
  assert.equal(scenarioProgress({ elapsed: 5, end_time: 10 }), 0.5);
  assert.equal(scenarioProgress({ elapsed: 50, end_time: 10 }), 1);
  assert.equal(scenarioProgress({ elapsed: 1, end_time: null }), null);
  assert.equal(scenarioProgress(null), null);
  assert.equal(fmtTimestamp(NaN), "-");
  assert.match(fmtTimestamp(0), /\d/);
});

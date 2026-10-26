import { describe, expect, it } from "vitest";

import { mergeImported, parseImport } from "../transfer";
import { newDestination, type ForwardDestination } from "../types";

const valid = (over: Partial<ForwardDestination> = {}): ForwardDestination => ({
  ...newDestination(),
  id: "a",
  name: "舞台左",
  targetIp: "10.0.0.5",
  ...over,
});

const json = (v: unknown) => JSON.stringify(v);

describe("parseImport 顶层结构", () => {
  it("本应用导出的数组格式可以原样读回", () => {
    const list = [valid({ id: "a" }), valid({ id: "b", name: "舞台右", targetIp: "10.0.0.6" })];
    const r = parseImport(json(list));
    expect(r).toEqual({ ok: true, destinations: list });
  });

  it("同时接受 { destinations: [...] } 形式", () => {
    const r = parseImport(json({ destinations: [valid()] }));
    expect(r.ok && r.destinations).toHaveLength(1);
  });

  it("不是 JSON、不是数组或为空都会被拒绝", () => {
    expect(parseImport("{oops")).toEqual({ ok: false, error: { kind: "json" } });
    expect(parseImport(json({ foo: 1 }))).toEqual({ ok: false, error: { kind: "shape" } });
    expect(parseImport(json("hi"))).toEqual({ ok: false, error: { kind: "shape" } });
    expect(parseImport(json([]))).toEqual({ ok: false, error: { kind: "empty" } });
  });
});

describe("parseImport 补默认值", () => {
  it("缺省字段按默认值补齐，端口随协议", () => {
    const r = parseImport(
      json([
        { name: "A", targetIp: "10.0.0.1", protocol: "artNet", mode: "all" },
        { name: "B", targetIp: "10.0.0.2", protocol: "sacn", mode: "selected" },
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [a, b] = r.destinations;
    expect(a).toMatchObject({
      port: 6454,
      universeOffset: 0,
      defaultDelayMs: 0,
      description: "",
      enabled: true,
      overrides: [],
    });
    expect(a.id).toBeTruthy();
    expect(b.port).toBe(5568);
    expect(a.id).not.toBe(b.id);
  });

  it("覆盖规则的可空字段缺省为 null", () => {
    const r = parseImport(
      json([{ ...valid(), overrides: [{ sourceUniverse: 3, action: "exclude" }] }]),
    );
    expect(r.ok && r.destinations[0].overrides).toEqual([
      { sourceUniverse: 3, action: "exclude", targetUniverse: null, delayMs: null },
    ]);
  });

  it("文件内重复的 id 会被替换成新 id", () => {
    const r = parseImport(json([valid({ id: "x" }), valid({ id: "x", name: "另一个" })]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.destinations[0].id).toBe("x");
    expect(r.destinations[1].id).not.toBe("x");
  });
});

describe("parseImport 错误定位", () => {
  it("指出第几项的哪个字段", () => {
    const r = parseImport(json([valid(), valid({ targetIp: "999.1.1.1" })]));
    expect(r).toEqual({
      ok: false,
      error: { kind: "item", index: 2, field: "targetIp", code: "ipInvalid" },
    });
  });

  it("取值越界按校验规则拒绝", () => {
    expect(parseImport(json([valid({ port: 70000 })]))).toEqual({
      ok: false,
      error: { kind: "item", index: 1, field: "port", code: "portInvalid" },
    });
    expect(parseImport(json([valid({ defaultDelayMs: 5000 })]))).toEqual({
      ok: false,
      error: { kind: "item", index: 1, field: "defaultDelayMs", code: "delayInvalid" },
    });
  });

  it("枚举值非法", () => {
    const base = { name: "A", targetIp: "10.0.0.1" };
    expect(parseImport(json([{ ...base, protocol: "dmx", mode: "all" }]))).toEqual({
      ok: false,
      error: { kind: "item", index: 1, field: "protocol", code: "protocolInvalid" },
    });
    expect(parseImport(json([{ ...base, protocol: "artNet", mode: "some" }]))).toEqual({
      ok: false,
      error: { kind: "item", index: 1, field: "mode", code: "modeInvalid" },
    });
    expect(
      parseImport(
        json([
          { ...base, protocol: "artNet", mode: "all", overrides: [{ sourceUniverse: 1, action: "x" }] },
        ]),
      ),
    ).toEqual({
      ok: false,
      error: { kind: "item", index: 1, field: "overrides", code: "actionInvalid" },
    });
  });

  it("类型不对：条目不是对象、数值字段是字符串", () => {
    expect(parseImport(json([42]))).toEqual({
      ok: false,
      error: { kind: "item", index: 1, field: "item", code: "typeInvalid" },
    });
    expect(parseImport(json([{ ...valid(), port: "6454" }]))).toEqual({
      ok: false,
      error: { kind: "item", index: 1, field: "port", code: "portInvalid" },
    });
  });

  it("缺少名称或目标 IP", () => {
    expect(parseImport(json([{ targetIp: "10.0.0.1", protocol: "artNet", mode: "all" }]))).toEqual({
      ok: false,
      error: { kind: "item", index: 1, field: "name", code: "nameRequired" },
    });
    expect(parseImport(json([{ name: "A", protocol: "artNet", mode: "all" }]))).toEqual({
      ok: false,
      error: { kind: "item", index: 1, field: "targetIp", code: "ipRequired" },
    });
  });
});

describe("mergeImported", () => {
  it("追加到末尾，不修改入参", () => {
    const current = [valid({ id: "a" })];
    const imported = [valid({ id: "b", name: "B" })];
    const merged = mergeImported(current, imported);
    expect(merged.map((d) => d.id)).toEqual(["a", "b"]);
    expect(current).toHaveLength(1);
  });

  it("与现有条目 id 冲突的导入项换新 id，其余保持", () => {
    const current = [valid({ id: "a" })];
    const imported = [valid({ id: "a", name: "撞 id" }), valid({ id: "c", name: "C" })];
    const merged = mergeImported(current, imported);
    expect(merged).toHaveLength(3);
    expect(merged[1].name).toBe("撞 id");
    expect(merged[1].id).not.toBe("a");
    expect(merged[2].id).toBe("c");
    expect(new Set(merged.map((d) => d.id)).size).toBe(3);
  });
});
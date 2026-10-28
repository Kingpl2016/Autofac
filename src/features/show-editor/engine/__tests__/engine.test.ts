import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createEmptyProject } from "../../lib/project";
import { loadTestEngine } from "./testEngine";

describe("show-engine WASM", () => {
  it("产物与 crate 版本一致，且不依赖任何宿主导入", () => {
    const engine = loadTestEngine();
    const cargo = readFileSync(path.resolve(__dirname, "../../../../../src-tauri/crates/show-engine-wasm/Cargo.toml"), "utf8");
    expect(cargo).toContain(`version = "${engine.version}"`);
    const module = new WebAssembly.Module(readFileSync(path.resolve(__dirname, "..", "show_engine.wasm")));
    expect(WebAssembly.Module.imports(module)).toEqual([]);
  });

  it("编译、求值、读取帧；释放后求值为空", () => {
    const engine = loadTestEngine();
    const p = createEmptyProject("t");
    p.output.gamma = 1;
    p.fixtureModels = [
      {
        id: "m",
        name: "m",
        system: "",
        productType: "",
        builtin: false,
        properties: (["red", "green", "blue", "white"] as const).map((fn, i) => ({
          name: fn,
          code: fn,
          function: fn,
          channel: i + 1,
          width: 1 as const,
          bigEndian: true,
          defaultValue: 0,
          valueDesc: "",
          description: "",
        })),
      },
    ];
    p.fixtures = [{ id: "f", name: "F", modelId: "m", universe: 2, address: 5 }];
    p.tracks = [{ id: "t", target: { kind: "fixture", id: "f" }, mute: false, solo: false, lock: false }];
    p.cues = [
      { kind: "static", id: "c", trackId: "t", startMs: 0, endMs: 1000, brightness: 100, fadeInMs: 0, fadeOutMs: 0, easing: "linear", rgb: [255, 153, 51] },
    ];
    const compiled = engine.compile(p);
    expect(compiled).not.toBeNull();
    if (!compiled) return;
    expect(compiled.fixtureIds).toEqual(["f"]);
    expect(compiled.universes).toEqual([2]);
    const preview = compiled.previewAt(500);
    // RGBW：白光 0.2 + RGB 余量，合成后的实际颜色等于目标色（线性 1/0.6/0.2）；
    // 预览按工程 Gamma 反向编码，所以预览色就是挑选的颜色
    expect(Array.from(preview)).toEqual([255, 153, 51]);
    expect(Array.from(compiled.frame(0)?.slice(4, 8) ?? [])).toEqual([204, 102, 0, 51]);
    expect(compiled.frame(1)).toBeNull();
    compiled.dispose();
    expect(compiled.alive).toBe(false);
    expect(compiled.previewAt(500)).toHaveLength(0);
  });

  it("Gamma 2 的 RGB 灯：预览色等于挑选色，DMX 按 Gamma 解码", () => {
    const engine = loadTestEngine();
    const p = createEmptyProject("g2");
    p.output.gamma = 2;
    p.fixtureModels = [
      {
        id: "m",
        name: "m",
        system: "",
        productType: "",
        builtin: false,
        properties: (["red", "green", "blue"] as const).map((fn, i) => ({
          name: fn,
          code: fn,
          function: fn,
          channel: i + 1,
          width: 1 as const,
          bigEndian: true,
          defaultValue: 0,
          valueDesc: "",
          description: "",
        })),
      },
    ];
    p.fixtures = [{ id: "f", name: "F", modelId: "m", universe: 0, address: 1 }];
    p.tracks = [{ id: "t", target: { kind: "fixture", id: "f" }, mute: false, solo: false, lock: false }];
    p.cues = [
      { kind: "static", id: "c", trackId: "t", startMs: 0, endMs: 1000, brightness: 100, fadeInMs: 0, fadeOutMs: 0, easing: "linear", rgb: [255, 128, 0] },
    ];
    const compiled = engine.compile(p);
    expect(compiled).not.toBeNull();
    if (!compiled) return;
    const preview = Array.from(compiled.previewAt(500));
    // 旧实现按 sRGB 编码，橙色会显示成 [255, 137, 0]
    preview.forEach((v, i) => expect(Math.abs(v - [255, 128, 0][i])).toBeLessThanOrEqual(1));
    // (128/255)^2 × 255 ≈ 64
    const dmx = Array.from(compiled.frame(0)?.slice(0, 3) ?? []);
    expect(dmx[0]).toBe(255);
    expect(Math.abs(dmx[1] - 64)).toBeLessThanOrEqual(1);
    expect(dmx[2]).toBe(0);
    compiled.dispose();
  });

  it("v2 工程（外观片段 + 分布 + 场景片段 + 预设）的 JSON 形态与 Rust 一致", () => {
    const engine = loadTestEngine();
    const p = createEmptyProject("v2");
    p.output.gamma = 1;
    p.fixtureModels = [
      {
        id: "spot",
        name: "spot",
        system: "",
        productType: "",
        builtin: false,
        properties: [
          { name: "d", code: "D", function: "dimmer", channel: 1, width: 1, bigEndian: true, defaultValue: 0, valueDesc: "", description: "" },
          { name: "p", code: "P", function: "pan", channel: 2, width: 1, bigEndian: true, defaultValue: 128, valueDesc: "", description: "" },
        ],
      },
    ];
    p.fixtures = [0, 1, 2].map((i) => ({ id: `f${i}`, name: `F${i}`, modelId: "spot", universe: 0, address: 1 + i * 2 }));
    p.groups = [{ id: "g", name: "G", fixtureIds: ["f0", "f1", "f2"] }];
    p.presets = [{ id: "half", name: "半亮", group: "intensity", look: { intensity: { kind: "value", value: 50 } } }];
    p.tracks = [
      { id: "tg", target: { kind: "group", id: "g" }, mute: false, solo: false, lock: false },
      { id: "ts", target: { kind: "scene" }, mute: false, solo: false, lock: false, name: "场景" },
    ];
    const base = { brightness: 100, fadeInMs: 0, fadeOutMs: 0, easing: "linear" as const };
    p.cues = [
      {
        ...base,
        id: "look",
        trackId: "tg",
        startMs: 0,
        endMs: 1000,
        kind: "look",
        look: { presetId: "half", attrs: { pan: { kind: "value", value: 0 } } },
        spread: { values: { pan: { from: 0, to: 1 } } },
      },
      {
        ...base,
        id: "scene",
        trackId: "ts",
        startMs: 500,
        endMs: 1000,
        kind: "scene",
        entries: [{ fixtureId: "f2", look: { intensity: { kind: "value", value: 100 } } }],
      },
    ];
    const compiled = engine.compile(p);
    expect(compiled?.warnings).toEqual([]);
    compiled?.previewAt(100);
    expect(Array.from(compiled?.frame(0)?.slice(0, 6) ?? [])).toEqual([128, 0, 128, 128, 128, 255]);
    compiled?.previewAt(600);
    // 场景片段把 f2 调光拉到 100%（HTP）
    expect(compiled?.frame(0)?.[4]).toBe(255);
    compiled?.dispose();
  });

  it("引擎无法解析的工程返回 null", () => {
    const engine = loadTestEngine();
    expect(engine.compile({ durationMs: "x" } as never)).toBeNull();
  });
});

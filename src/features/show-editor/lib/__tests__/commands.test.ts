import { describe, expect, it } from "vitest";

import {
  chordOf,
  effectiveKeys,
  findConflicts,
  formatChord,
  fuzzyMatch,
  matchCommand,
  parseChord,
  rankCommands,
  type Command,
} from "../commands";

const ev = (key: string, mods: Partial<{ ctrl: boolean; meta: boolean; shift: boolean; alt: boolean }> = {}) => ({
  key,
  ctrlKey: mods.ctrl ?? false,
  metaKey: mods.meta ?? false,
  shiftKey: mods.shift ?? false,
  altKey: mods.alt ?? false,
});

const cmd = (id: string, keys: string[], extra: Partial<Command> = {}): Command => ({
  id,
  titleKey: id,
  category: "edit",
  keys,
  run: () => {},
  ...extra,
});

describe("快捷键 chord", () => {
  it("由键盘事件规整：Ctrl 与 ⌘ 都记作 mod，修饰键顺序固定", () => {
    expect(chordOf(ev("Z", { ctrl: true, shift: true }))).toBe("mod+shift+z");
    expect(chordOf(ev("b", { meta: true }))).toBe("mod+b");
    expect(chordOf(ev(" "))).toBe("space");
    expect(chordOf(ev("ArrowRight", { shift: true }))).toBe("shift+arrowright");
    expect(chordOf(ev("+", { shift: true }))).toBe("+");
    expect(chordOf(ev("Control", { ctrl: true }))).toBe("");
  });

  it("手写 chord 规整与格式化", () => {
    expect(parseChord("Ctrl+Shift+Z")).toBe("mod+shift+z");
    expect(parseChord("shift+alt+K")).toBe("mod+alt+shift+k".replace("mod+", ""));
    expect(parseChord("mod++")).toBe("mod++");
    expect(parseChord("")).toBe("");
    expect(formatChord("mod+shift+z")).toBe("Ctrl+Shift+Z");
    expect(formatChord("space")).toBe("Space");
    expect(formatChord("shift+arrowleft")).toBe("Shift+←");
    expect(formatChord("mod++")).toBe("Ctrl++");
  });

  it("自定义覆盖默认，冲突检测", () => {
    const a = cmd("a", ["mod+b"]);
    const b = cmd("b", ["s"]);
    expect(effectiveKeys(a, {})).toEqual(["mod+b"]);
    expect(effectiveKeys(a, { a: ["Ctrl+K"] })).toEqual(["mod+k"]);
    expect(effectiveKeys(a, { a: [] })).toEqual([]);
    expect(findConflicts([a, b], { b: ["mod+b"] })).toEqual([["mod+b", ["a", "b"]]]);
  });

  it("匹配命令：不可用的跳过，输入框里只响应全局命令", () => {
    const save = cmd("save", ["mod+s"], { global: true });
    const del = cmd("del", ["delete"], { enabled: () => false });
    const del2 = cmd("del2", ["delete"]);
    expect(matchCommand([save, del, del2], {}, ev("Delete"), false)?.id).toBe("del2");
    expect(matchCommand([save, del2], {}, ev("Delete"), true)).toBeNull();
    expect(matchCommand([save], {}, ev("s", { ctrl: true }), true)?.id).toBe("save");
  });
});

describe("模糊搜索", () => {
  it("按顺序出现即命中，词首与连续加分", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, indices: [] });
    expect(fuzzyMatch("spl", "Split clip")).not.toBeNull();
    expect(fuzzyMatch("xyz", "Split clip")).toBeNull();
    const prefix = fuzzyMatch("zoom", "Zoom in")?.score ?? 0;
    const inner = fuzzyMatch("zoom", "Fit zoom")?.score ?? 0;
    expect(prefix).toBeGreaterThan(inner);
    expect(fuzzyMatch("分割", "分割片段")?.indices).toEqual([0, 1]);
  });

  it("命令排序：标题命中优先于分类命中", () => {
    const list = [cmd("a", []), cmd("b", [])];
    const titles: Record<string, string> = { a: "保存", b: "播放 / 暂停" };
    const ranked = rankCommands(list, "播放", (c) => titles[c.id], () => "传输");
    expect(ranked.map((r) => r.command.id)).toEqual(["b"]);
    const byCategory = rankCommands(list, "传输", (c) => titles[c.id], (c) => (c.id === "b" ? "传输" : "文件"));
    expect(byCategory.map((r) => r.command.id)).toEqual(["b"]);
  });
});

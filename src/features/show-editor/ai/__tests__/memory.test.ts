import { describe, expect, it } from "vitest";

import { addMemory, removeMemory, updateMemory, MAX_MEMORY_ITEMS, type MemoryItem } from "@/features/ai/lib/memory";
import {
  addExemplar,
  buildMemory,
  EMPTY_MEMORY,
  hasShowAliases,
  makeExemplar,
  MAX_EXEMPLAR_CHARS,
  pickExemplars,
  similarity,
  tokens,
  type Exemplar,
} from "../memory";

const item = (id: string, text: string, enabled = true): MemoryItem => ({ id, text, enabled, createdAt: 0 });
const ex = (id: string, request: string, createdAt = 0, ops: object[] = [{ op: "editCues", cues: ["selection"] }]): Exemplar => ({
  ...makeExemplar(request, `s-${id}`, ops, createdAt)!,
  id,
});

describe("记忆条目（个人偏好 / 工程笔记）", () => {
  it("添加：规范化、同样的内容不重复存（停用的重新启用）、超过上限丢掉最早的", () => {
    const a = addMemory([], "  不要   频闪 ", "u", 1);
    expect(a.item).toMatchObject({ text: "不要 频闪", enabled: true, createdAt: 1 });
    const off = updateMemory(a.list, a.item!.id, { enabled: false });
    const again = addMemory(off, "不要 频闪。", "u");
    expect(again.duplicate).toBe(true);
    expect(again.list).toHaveLength(1);
    expect(again.list[0].enabled).toBe(true);
    expect(addMemory([], "   ", "u").item).toBeNull();

    let list: MemoryItem[] = [];
    for (let i = 0; i < MAX_MEMORY_ITEMS + 2; i += 1) list = addMemory(list, `第 ${i} 条`, "n").list;
    expect(list).toHaveLength(MAX_MEMORY_ITEMS);
    expect(list[0].text).toBe("第 2 条");
  });

  it("修改文字、改成空文字时删除、删除", () => {
    const list = [item("a", "x"), item("b", "y")];
    expect(updateMemory(list, "a", { text: " z " })[0].text).toBe("z");
    expect(updateMemory(list, "a", { text: "  " })).toEqual([item("b", "y")]);
    expect(removeMemory(list, "b")).toEqual([item("a", "x")]);
  });
});

describe("范例", () => {
  it("切词：中文取单字与相邻两字，英文按单词", () => {
    expect([...tokens("副歌蓝")].sort()).toEqual(["副", "副歌", "歌", "歌蓝", "蓝"].sort());
    expect([...tokens("Make the chorus BLUE, x2")].sort()).toEqual(["blue", "chorus", "make", "the", "x2"].sort());
    expect(similarity(tokens("副歌改成蓝紫色"), tokens("副歌改成蓝紫色"))).toBe(1);
    expect(similarity(new Set(), tokens("a"))).toBe(0);
  });

  it("生成：去掉 null 字段；操作太长或没有用户的话时不记", () => {
    expect(makeExemplar("副歌改蓝紫", "s", [{ op: "editCues", cues: ["C3"], colors: ["blue"], speed: null }])?.ops).toEqual([
      { op: "editCues", cues: ["C3"], colors: ["blue"] },
    ]);
    expect(makeExemplar("  ", "s", [{ op: "x" }])).toBeNull();
    expect(makeExemplar("长", "s", [{ op: "addMarker", label: "x".repeat(MAX_EXEMPLAR_CHARS) }])).toBeNull();
  });

  it("工程别名：灯具、分组、轨道、片段、标记点、素材库模型算；段落、all、selection 不算", () => {
    expect(hasShowAliases([{ op: "editCues", cues: ["C3"] }])).toBe(true);
    expect(hasShowAliases([{ op: "addEffect", target: "G1", from: "S1", to: "S1:end" }])).toBe(true);
    expect(hasShowAliases([{ op: "addEffect", target: "all", from: "S2", to: "S2:end" }])).toBe(false);
    expect(hasShowAliases([{ op: "editCues", cues: ["selection"], speed: "x2" }])).toBe(false);
  });

  it("同一句话只留最新的；超过上限丢掉最早的", () => {
    const list = addExemplar(addExemplar([ex("a", "副歌改蓝紫", 1)], ex("b", "副歌改蓝紫。", 2), 10), ex("c", "主歌暗一点", 3), 2);
    expect(list.map((e) => e.id)).toEqual(["b", "c"]);
    expect(addExemplar(list, ex("d", "尾声", 4), 2).map((e) => e.id)).toEqual(["c", "d"]);
  });

  it("挑选：相似度从高到低、同分时新的在前；低于门槛、停用的不选；本工程优先于共用的同一句话", () => {
    const snapshot = {
      exemplars: [ex("p1", "副歌改成蓝紫色", 1), ex("p2", "副歌改成暖色", 5), ex("off", "主歌改成冷色", 9)].map((e) =>
        e.id === "off" ? { ...e, enabled: false } : e,
      ),
      shared: [ex("g1", "副歌改成蓝紫色", 9), ex("g2", "前奏加摇头灯", 9)],
    };
    const picked = pickExemplars("主歌也改成冷色", snapshot);
    expect(picked.map((p) => p.ex.id)).toEqual(["p2", "p1"]);
    expect(picked.every((p) => p.kind === "exemplar")).toBe(true);
    expect(pickExemplars("前奏加点摇头灯", snapshot).map((p) => [p.kind, p.ex.id])).toEqual([["shared", "g2"]]);
    expect(pickExemplars("你好", snapshot)).toEqual([]);
    expect(pickExemplars("", snapshot)).toEqual([]);
    // 相同输入总是相同结果
    expect(pickExemplars("主歌也改成冷色", snapshot)).toEqual(picked);
  });

  it("放进提示词：启用的偏好与笔记全部放入，对话再加最相关的范例；草稿不带范例；没有记忆时为空", () => {
    expect(buildMemory(EMPTY_MEMORY, "x", "chat")).toEqual({ text: "", used: [] });
    const snapshot = {
      prefs: [item("u1", "不要频闪"), item("u2", "停用的", false)],
      notes: [item("n1", "G1 是前排帕灯")],
      exemplars: [ex("e1", "副歌改成蓝紫色", 1, [{ op: "editCues", cues: ["C3"], colors: ["blue", "violet"] }])],
      shared: [],
    };
    const chat = buildMemory(snapshot, "主歌改成蓝紫色", "chat");
    expect(chat.used).toEqual([
      { kind: "pref", id: "u1" },
      { kind: "note", id: "n1" },
      { kind: "exemplar", id: "e1" },
    ]);
    expect(chat.text).toContain("User preferences (all shows):\n- 不要频闪");
    expect(chat.text).toContain("Notes for this show:\n- G1 是前排帕灯");
    expect(chat.text).toContain('- "副歌改成蓝紫色" → propose_ops({"summary":"s-e1","ops":[{"op":"editCues","cues":["C3"],"colors":["blue","violet"]}]})');
    expect(chat.text).not.toContain("停用的");
    const draft = buildMemory(snapshot, "主歌改成蓝紫色", "draft");
    expect(draft.used.map((r) => r.kind)).toEqual(["pref", "note"]);
    expect(draft.text).not.toContain("propose_ops");
  });
});

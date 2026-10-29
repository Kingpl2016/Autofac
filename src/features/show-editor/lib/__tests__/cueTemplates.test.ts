import { describe, expect, it } from "vitest";

import builtinFile from "../builtinCueTemplates.json";
import { templateNeeds } from "../cueDefaults";
import {
  BUILTIN_TEMPLATES,
  groupTemplates,
  mergeTemplates,
  parseTemplates,
  parseTemplateText,
  serializeTemplates,
  templateName,
  templateRgb,
  uniqueTemplateId,
  type CueTemplate,
} from "../cueTemplates";
import { copyToUser, importTemplates, removeTemplate, renameTemplate, setTemplateGroup, templateFromCue } from "../templateOps";

const mine = (over: Partial<CueTemplate> = {}): CueTemplate => ({
  id: "my-1",
  name: "我的红",
  group: "custom",
  color: { kind: "rgb", rgb: [200, 0, 0] },
  brightness: 100,
  fadeInMs: 0,
  fadeOutMs: 0,
  ...over,
});

describe("Cue 模板配置文件", () => {
  it("内置模板文件全部合法：基础色、舞台常用色、白光色温三组，id 不重复", () => {
    expect(parseTemplates(builtinFile).issues).toEqual([]);
    expect(BUILTIN_TEMPLATES.length).toBe(builtinFile.templates.length);
    expect(new Set(BUILTIN_TEMPLATES.map((t) => t.id)).size).toBe(BUILTIN_TEMPLATES.length);
    expect(groupTemplates(BUILTIN_TEMPLATES).map((g) => [g.group, g.templates.length > 0])).toEqual([
      ["basic", true],
      ["stage", true],
      ["white", true],
    ]);
    expect(BUILTIN_TEMPLATES.filter((t) => t.group === "stage").length).toBeGreaterThanOrEqual(20);
    expect(BUILTIN_TEMPLATES.every((t) => t.builtin)).toBe(true);
  });

  it("解析：缺省值补齐；格式不对的条目跳过并说明第几条；id 重复时后一条覆盖", () => {
    const r = parseTemplates({
      version: 1,
      templates: [
        { id: "a", name: "甲", color: { kind: "kelvin", kelvin: 3200 } },
        { id: "b", name: "乙", color: { kind: "rgb", rgb: [300, 0, 0] } },
        { name: "无 id", color: { kind: "rgb", rgb: [0, 0, 0] } },
        { id: "a", name: { en: "A2" }, group: "舞台", color: { kind: "rgb", rgb: [1, 2, 3] }, brightness: 50 },
      ],
    });
    expect(r.templates).toEqual([
      { id: "a", name: { en: "A2" }, group: "舞台", color: { kind: "rgb", rgb: [1, 2, 3] }, brightness: 50, fadeInMs: 0, fadeOutMs: 0 },
    ]);
    expect(r.issues.map((i) => i.index)).toEqual([2, 3]);
    expect(r.issues[0].message).toContain("color");
    expect(parseTemplateText("{oops").issues).toEqual([{ index: null, message: "json" }]);
    expect(parseTemplates({ list: [] }).templates).toEqual([]);
  });

  it("序列化去掉运行时标记，能原样读回", () => {
    const text = serializeTemplates([{ ...mine(), builtin: true }]);
    expect(text).not.toContain("builtin");
    expect(parseTemplateText(text).templates).toEqual([mine()]);
  });

  it("合并：同 id 用户覆盖内置（位置不变），其余追加；分组顺序：内置分组 → 自建分组 → 我的", () => {
    const override = mine({ id: "red", name: "我的红", group: "basic" });
    const merged = mergeTemplates(BUILTIN_TEMPLATES, [mine(), override, mine({ id: "x", group: "演唱会" })]);
    const redIndex = BUILTIN_TEMPLATES.findIndex((t) => t.id === "red");
    expect(merged[redIndex]).toBe(override);
    expect(merged.slice(-2).map((t) => t.id)).toEqual(["my-1", "x"]);
    expect(groupTemplates(merged).map((g) => g.group)).toEqual(["basic", "stage", "white", "演唱会", "custom"]);
  });

  it("显示名按语言取，缺的语言用另一个；色温换算显示色；需求按颜色判断", () => {
    expect(templateName({ id: "a", name: { zh: "红" } }, "en")).toBe("红");
    expect(templateName({ id: "a", name: { zh: "红", en: "Red" } }, "en-US")).toBe("Red");
    expect(templateRgb({ color: { kind: "kelvin", kelvin: 2700 } })[0]).toBe(255);
    expect(templateNeeds({ color: { kind: "kelvin", kelvin: 5600 } })).toBe("intensity");
    expect(templateNeeds({ color: { kind: "rgb", rgb: [255, 250, 245] } })).toBe("intensity");
    expect(templateNeeds({ color: { kind: "rgb", rgb: [255, 0, 0] } })).toBe("mixing");
    expect(uniqueTemplateId([{ id: "my-1" }, { id: "my-2" }])).toBe("my-3");
  });
});

describe("用户模板的编辑", () => {
  it("复制内置模板为我的模板；改名、改分组、删除", () => {
    const red = BUILTIN_TEMPLATES.find((t) => t.id === "red")!;
    const { next, created } = copyToUser([], BUILTIN_TEMPLATES, red, " 副本");
    expect(created).toMatchObject({ id: "my-1", name: { zh: "红 副本", en: "Red 副本" }, group: "custom" });
    expect(created.builtin).toBeUndefined();
    const renamed = renameTemplate(next, "my-1", "  开场红 ");
    expect(renamed[0].name).toBe("开场红");
    expect(renameTemplate(next, "my-1", "  ")[0].name).toEqual(created.name);
    expect(setTemplateGroup(renamed, "my-1", "演唱会")[0].group).toBe("演唱会");
    expect(setTemplateGroup(renamed, "my-1", " ")[0].group).toBe("custom");
    expect(removeTemplate(renamed, "my-1")).toEqual([]);
  });

  it("导入：同 id 替换、其余追加并计数", () => {
    const r = importTemplates([mine()], [mine({ name: "新红" }), mine({ id: "my-9", builtin: true })]);
    expect([r.added, r.replaced]).toEqual([1, 1]);
    expect(r.next.map((t) => [t.id, t.name])).toEqual([
      ["my-1", "新红"],
      ["my-9", "我的红"],
    ]);
    expect(r.next.some((t) => "builtin" in t)).toBe(false);
  });

  it("从片段取模板：静态片段取颜色；外观片段取颜色层开头的值；只有强度的为外观模板；发光体直给也能存", () => {
    const base = { id: "c", trackId: "t", startMs: 0, endMs: 1000, brightness: 80, fadeInMs: 100, fadeOutMs: 200, easing: "linear" as const };
    expect(templateFromCue({ ...base, kind: "static", rgb: [1, 2, 3] })).toEqual({
      brightness: 80,
      fadeInMs: 100,
      fadeOutMs: 200,
      length: { kind: "ms", ms: 1000 },
      color: { kind: "rgb", rgb: [1, 2, 3] },
    });
    expect(
      templateFromCue({ ...base, kind: "look", look: { color: { kind: "value", value: { kind: "kelvin", kelvin: 3200 } } } })?.color,
    ).toEqual({ kind: "kelvin", kelvin: 3200 });
    expect(templateFromCue({ ...base, kind: "look", look: { intensity: { kind: "value", value: 100 } } })).toMatchObject({
      kind: "look",
      look: { intensity: { kind: "value", value: 100 } },
      color: { kind: "rgb", rgb: [255, 255, 255] },
    });
    expect(
      templateFromCue({ ...base, kind: "look", look: { color: { kind: "value", value: { kind: "manual", values: { red: 1 } } } } })?.color,
    ).toEqual({ kind: "manual", values: { red: 1 } });
    expect(templateFromCue({ ...base, kind: "look", look: {} })).toBeNull();
  });
});
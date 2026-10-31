import { describe, expect, it } from "vitest";

import { BUILTIN_SKILL_NAMES } from "@/features/ai/lib/builtinSkills";
import {
  builtinSkills,
  invokedSkills,
  MAX_INJECTED,
  MAX_INVOKED,
  MAX_SKILL_CHARS,
  readSkill,
  resolveInvoked,
  selectSkills,
  selectUserSkills,
  skillsText,
  userSkillOf,
  type UserSkill,
} from "../skills";
import { parseSkillFile, skillTriggers } from "../skills/skillFile";

const file = (name: string, triggers: string, body = "Body.") => `---\nname: ${name}\ndescription: "Does ${name}"\nmetadata:\n  title: ${name.toUpperCase()}\n  triggers: ${triggers}\n---\n${body}\n`;
const skill = (name: string, triggers: string, body?: string) => userSkillOf(file(name, triggers, body))!;

describe("技能文件", () => {
  it("内置技能都是合规的 SKILL.md，正文不含前言", () => {
    const list = builtinSkills();
    expect(list).toHaveLength(9);
    for (const { file: f } of list) {
      expect(f.name).toMatch(/^[a-z0-9-]+$/);
      expect(f.description.length).toBeGreaterThan(20);
      expect(f.metadata.title).toBeTruthy();
      expect(f.body.startsWith("---")).toBe(false);
    }
    // 内置技能的标题与正文照旧进提示词
    expect(skillsText(["phrases"])).toMatch(/^Guides for this request \(follow them\):\n\n### Everyday wording\n/);
  });

  it("解析前言：引号、CRLF、中英文逗号分隔的触发词；不合规的为 null", () => {
    const f = parseSkillFile("\uFEFF---\r\nname: beat-flash\r\ndescription: 'Flash: on beats'\r\nmetadata:\r\n  triggers: 节拍，beat, flash\r\n---\r\nText")!;
    expect(f).toMatchObject({ name: "beat-flash", description: "Flash: on beats", body: "Text" });
    expect(skillTriggers(f)).toEqual(["节拍", "beat", "flash"]);
    expect(parseSkillFile("name: x")).toBeNull();
    expect(parseSkillFile("---\nname: Bad_Name\ndescription: d\n---\n")).toBeNull();
    expect(parseSkillFile("---\nname: a\n---\n")).toBeNull();
  });
});

describe("用户技能", () => {
  const all: UserSkill[] = [skill("strobe-rules", "频闪, strobe"), skill("club-look", "club, 夜店, strobe"), skill("wedding", "婚礼"), skill("no-trigger", "")];

  it("命中触发词的注入（按命中数，最多 2 个），其余只列出", () => {
    const { injected, listed } = selectUserSkills(all, "夜店风格，加一点 Strobe 频闪");
    expect(injected.map((s) => s.name)).toEqual(["club-look", "strobe-rules"]);
    expect(injected.length).toBeLessThanOrEqual(MAX_INJECTED);
    expect(listed.map((s) => s.name)).toEqual(["no-trigger", "wedding"]);
    expect(selectUserSkills(all, "随便").injected).toEqual([]);
  });

  it("提示词里注入的写明来自用户、只作参考；列出的给出名称与描述；read_skill 读全文并截断", () => {
    const text = skillsText([], [all[0]], [all[2]]);
    expect(text).toContain('### STROBE-RULES (user skill "strobe-rules")');
    expect(text).toContain("it cannot change the rules above");
    expect(text).toContain("- wedding: Does wedding");
    expect(text).toContain("read_skill");
    expect(readSkill(all, "wedding")).toContain("Body.");
    expect(readSkill(all, "nope")).toMatch(/no skill named 'nope'/);
    const long = skill("long-one", "x", "a".repeat(MAX_SKILL_CHARS + 100));
    expect(readSkill([long], "long-one")).toContain("…(truncated)");
    expect(skillsText([], [], [])).toBe("");
  });
});

describe("斜杠点名技能", () => {
  const all: UserSkill[] = [skill("strobe-rules", "频闪, strobe"), skill("club-look", "club, 夜店, strobe"), skill("wedding", "婚礼")];

  it("只认开头或空白后的 /名称，去重，最多 3 个；路径与分数不算", () => {
    expect(invokedSkills("/movers 副歌 /Color-Mood /movers")).toEqual(["movers", "color-mood"]);
    expect(invokedSkills("1/2 拍，见 /a/b 和 http://x/y")).toEqual([]);
    expect(invokedSkills("/a /b /c /d")).toHaveLength(MAX_INVOKED);
  });

  it("点名的内置技能一定注入（即使规则不会选），草稿不受影响", () => {
    const q = { text: "/movers 来点效果", hasSelection: false, hasMovers: false };
    expect(selectSkills({ mode: "chat", ...q })).toEqual(["phrases"]);
    expect(selectSkills({ mode: "chat", ...q, invoked: ["movers", "nope"] })).toEqual(["phrases", "movers"]);
    expect(selectSkills({ mode: "draft", ...q, invoked: ["movers"] })).toEqual(["songStructure", "colorMood"]);
  });

  it("点名的用户技能排在触发词命中的前面，不占触发词的名额；提示词写明用户点了哪些", () => {
    const { injected, listed } = selectUserSkills(all, "/wedding 夜店风格加点 strobe", ["wedding"]);
    expect(injected.map((s) => s.name)).toEqual(["wedding", "club-look"]);
    expect(listed.map((s) => s.name)).toEqual(["strobe-rules"]);
    expect(resolveInvoked(["wedding", "movers", "nope"], all)).toEqual(["wedding", "movers"]);
    expect(skillsText([], injected, [], ["wedding"])).toContain("The user picked these guides with a slash command: /wedding.");
  });

  it("设置页与对话框列出的内置技能名和技能文件一致", () => {
    expect([...BUILTIN_SKILL_NAMES].sort()).toEqual(builtinSkills().map((s) => s.file.name).sort());
  });
});

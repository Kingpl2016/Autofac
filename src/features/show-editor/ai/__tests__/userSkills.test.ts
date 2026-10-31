import { describe, expect, it } from "vitest";

import { builtinSkills, MAX_INJECTED, MAX_SKILL_CHARS, readSkill, selectUserSkills, skillsText, userSkillOf, type UserSkill } from "../skills";
import { parseSkillFile, skillTriggers } from "../skills/skillFile";

const file = (name: string, triggers: string, body = "Body.") => `---\nname: ${name}\ndescription: "Does ${name}"\nmetadata:\n  title: ${name.toUpperCase()}\n  triggers: ${triggers}\n---\n${body}\n`;
const skill = (name: string, triggers: string, body?: string) => userSkillOf(file(name, triggers, body))!;

describe("技能文件", () => {
  it("内置技能都是合规的 SKILL.md，正文不含前言", () => {
    const list = builtinSkills();
    expect(list).toHaveLength(7);
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

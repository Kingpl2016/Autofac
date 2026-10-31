import { describe, expect, it } from "vitest";

import { chatSystemPrompt, draftSystemPrompt } from "../prompt";
import { selectSkills, skillsText, type SkillQuery } from "../skills";

const chat = (text: string, over: Partial<SkillQuery> = {}) => selectSkills({ mode: "chat", text, hasSelection: false, hasMovers: false, ...over });

describe("内置技能", () => {
  it("草稿固定注入歌曲编排与颜色，有摇头灯时加动作", () => {
    expect(selectSkills({ mode: "draft", text: "", hasSelection: false, hasMovers: false })).toEqual(["songStructure", "colorMood"]);
    expect(selectSkills({ mode: "draft", text: "随便", hasSelection: false, hasMovers: true })).toEqual(["songStructure", "colorMood", "movers"]);
  });

  it("对话按这句话的关键词挑选，口语词表总是在", () => {
    expect(chat("你好")).toEqual(["phrases"]);
    expect(chat("副歌改成暖色")).toEqual(["phrases", "songStructure", "colorMood", "editClips"]);
    expect(chat("Make the chorus warmer")).toEqual(["phrases", "songStructure", "colorMood"]);
    expect(chat("摇头灯画圆", { hasMovers: true })).toEqual(["phrases", "movers"]);
    // 没有摇头灯时不注入动作
    expect(chat("摇头灯画圆")).toEqual(["phrases"]);
    // 说到段落时有摇头灯也带上动作
    expect(chat("前奏来点氛围", { hasMovers: true })).toEqual(["phrases", "songStructure", "colorMood", "movers"]);
    expect(chat("这个", { hasSelection: true })).toEqual(["phrases", "editClips"]);
    expect(chat("加 8 台帕灯，从地址 1 开始")).toEqual(["phrases", "patchOutput"]);
    expect(chat("switch the output to unicast")).toEqual(["phrases", "patchOutput"]);
  });

  it("有音乐分析时：提到节奏、重拍或段落才注入“按音乐编排”；草稿总是注入", () => {
    expect(chat("跟着鼓点闪", { hasMusic: true })).toEqual(["phrases", "musicArrange"]);
    expect(chat("副歌改成暖色", { hasMusic: true })).toEqual(["phrases", "songStructure", "musicArrange", "colorMood", "editClips"]);
    expect(chat("跟着鼓点闪")).toEqual(["phrases"]);
    expect(selectSkills({ mode: "draft", text: "", hasSelection: false, hasMovers: false, hasMusic: true })).toEqual(["songStructure", "musicArrange", "colorMood"]);
  });

  it("相同的输入得到完全相同的提示词", () => {
    const a = chatSystemPrompt("Show", skillsText(chat("副歌改成暖色")));
    const b = chatSystemPrompt("Show", skillsText(chat("副歌改成暖色")));
    expect(a).toBe(b);
    expect(a).toContain("### Song structure");
    expect(a).toContain("### Colors and mood");
    expect(a).toContain("chorusBurst [high]");
    expect(chatSystemPrompt("Show")).not.toContain("Guides for this request");
    expect(skillsText([])).toBe("");
    expect(draftSystemPrompt("Show", "", "", skillsText(["songStructure"]))).toContain("| chorus, 副歌, hook, 高潮 | high | chorusBurst |");
  });
});

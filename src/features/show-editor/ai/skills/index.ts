import colorMood from "./color-mood.md?raw";
import editClips from "./edit-clips.md?raw";
import movers from "./movers.md?raw";
import patchOutput from "./patch-output.md?raw";
import phrases from "./phrases.md?raw";
import songStructure from "./song-structure.md?raw";

/**
 * 内置技能（skills）：按场景注入系统提示词的编排知识（英文 Markdown，与提示词同一语言）。
 *
 * 技能由代码按确定的规则挑选（模式、用户这句话里的关键词、有没有选中片段、有没有摇头灯），
 * 不让模型自己决定读哪份：同一个请求在任何模型上看到的提示词完全相同，这是减小模型差异的前提。
 * 技能内容或挑选规则改了要递增 {@link SKILLS_VERSION}（并递增提示词版本）。
 */

/** 技能版本。 */
export const SKILLS_VERSION = 1;

/** 技能 id。 */
export type SkillId = "songStructure" | "colorMood" | "phrases" | "editClips" | "movers" | "patchOutput";

/** 一份技能：标题 + 正文。 */
const SKILLS: Record<SkillId, { title: string; body: string }> = {
  songStructure: { title: "Song structure", body: songStructure },
  colorMood: { title: "Colors and mood", body: colorMood },
  phrases: { title: "Everyday wording", body: phrases },
  editClips: { title: "Editing existing clips", body: editClips },
  movers: { title: "Moving heads", body: movers },
  patchOutput: { title: "Patch and output", body: patchOutput },
};

/** 技能在提示词里的顺序。 */
const ORDER: readonly SkillId[] = ["phrases", "songStructure", "colorMood", "movers", "editClips", "patchOutput"];

/** 挑选技能需要的信息。 */
export interface SkillQuery {
  /** `chat` 对话 / 编辑；`draft` 一键草稿。 */
  mode: "chat" | "draft";
  /** 用户这一轮说的话（草稿为描述）。 */
  text: string;
  /** 用户选中了片段。 */
  hasSelection: boolean;
  /** 工程里有摇头灯。 */
  hasMovers: boolean;
}

const SONG = /段落|主歌|副歌|前奏|间奏|尾声|结尾|高潮|桥段|整首|编排|歌|开场|\b(intro|verse|chorus|bridge|outro|drop|build|breakdown|section|song|arrange)/i;
const COLOR = /颜色|色|暖|冷|情绪|氛围|浪漫|忧伤|欢快|霓虹|白光|\b(colou?r|mood|warm|cool|palette|neon|romantic)/i;
const EDIT = /改|换|调|删|移|挪|拉长|缩短|加快|放慢|快|慢|亮|暗|选中|这个|这些|\b(change|edit|move|delete|remove|faster|slower|brighter|darker|replace|shorten|extend)/i;
const MOVE = /摇头|动作|画圆|扫|摇摆|走位|\b(pan|tilt|movers?|moving heads?|circle|sweep)/i;
const PATCH = /配接|地址|宇宙|输出|单播|广播|加\s*\d+\s*[台个盏]|添加灯|新增灯|\b(universe|patch|address|output|unicast|broadcast|sacn|art-?net|ip)\b/i;

/**
 * 挑选这一轮要注入的技能（确定性规则）。
 *
 * @param q 模式、用户的话与工程情况。
 * @returns 技能 id（按提示词里的顺序）。
 */
export function selectSkills(q: SkillQuery): SkillId[] {
  const picked = new Set<SkillId>();
  if (q.mode === "draft") {
    picked.add("songStructure").add("colorMood");
    if (q.hasMovers) picked.add("movers");
  } else {
    picked.add("phrases");
    if (SONG.test(q.text)) picked.add("songStructure");
    if (COLOR.test(q.text)) picked.add("colorMood");
    if (q.hasMovers && (MOVE.test(q.text) || picked.has("songStructure"))) picked.add("movers");
    if (q.hasSelection || EDIT.test(q.text)) picked.add("editClips");
    if (PATCH.test(q.text)) picked.add("patchOutput");
  }
  return ORDER.filter((id) => picked.has(id));
}

/**
 * 技能拼成提示词的一节。
 *
 * @param ids 技能 id。
 * @returns 文字；没有技能时为空串。
 */
export function skillsText(ids: readonly SkillId[]): string {
  if (ids.length === 0) return "";
  return ["Guides for this request (follow them):", ...ids.map((id) => `### ${SKILLS[id].title}\n${SKILLS[id].body.trim()}`)].join("\n\n");
}

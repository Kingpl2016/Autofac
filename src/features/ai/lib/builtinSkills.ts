/**
 * 内置技能的名称（与节目编辑器 `ai/skills/<name>/SKILL.md` 的 `name` 一致，有测试保证）。
 *
 * 技能正文在节目编辑器里（随 AI 代码按需加载），这里只放名称，供设置页列出、对话框的 `/` 菜单排序；
 * 显示用的标题与说明在语言包 `ai.skills.builtin.<name>` 下。顺序即显示顺序。
 */
export const BUILTIN_SKILL_NAMES = [
  "phrases",
  "song-structure",
  "music-arrange",
  "color-mood",
  "movers",
  "edit-clips",
  "custom-content",
  "stage-layout",
  "patch-output",
] as const;

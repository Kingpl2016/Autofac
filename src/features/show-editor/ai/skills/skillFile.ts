/**
 * `SKILL.md`（Agent Skills 格式）的前言解析（纯函数，与后端 `skill-store` 的规则一致）：
 * 顶层 `key: value`，`metadata:` 下缩进一层的 `key: value`，值可带引号。
 */

/** 解析出的技能文件。 */
export interface SkillFile {
  name: string;
  description: string;
  /** `metadata` 下的键值（`title`、`triggers`…） */
  metadata: Record<string, string>;
  /** 正文（去掉前言） */
  body: string;
}

/** 名称规则：1~64 个小写字母、数字与单个连字符。 */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const unquote = (v: string) => {
  const s = v.trim();
  return s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) ? s.slice(1, -1) : s;
};

/**
 * 解析 `SKILL.md`。
 *
 * @param text 全文。
 * @returns 结果；格式不对（没有前言、名称不合规、没有描述）时为 `null`。
 */
export function parseSkillFile(text: string): SkillFile | null {
  const src = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!src.startsWith("---\n")) return null;
  const end = src.indexOf("\n---", 3);
  if (end < 0) return null;
  const head = src.slice(4, end);
  const after = src.slice(end + 4);
  const body = after.startsWith("\n") ? after.slice(1) : after;
  const out: SkillFile = { name: "", description: "", metadata: {}, body };
  let inMeta = false;
  for (const raw of head.split("\n")) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const at = raw.indexOf(":");
    if (at < 0) return null;
    const key = raw.slice(0, at).trim();
    const value = unquote(raw.slice(at + 1));
    if (/^\s/.test(raw) && inMeta) {
      out.metadata[key] = value;
      continue;
    }
    inMeta = key === "metadata" && value === "";
    if (key === "name") out.name = value;
    else if (key === "description") out.description = value;
  }
  if (out.name.length > 64 || !SKILL_NAME.test(out.name) || !out.description || out.description.length > 1024) return null;
  return out;
}

/**
 * 触发词（`metadata.triggers`，中英文逗号分隔）。
 *
 * @param file 技能文件。
 * @returns 触发词（去空白，最多 20 个）。
 */
export function skillTriggers(file: Pick<SkillFile, "metadata">): string[] {
  return (file.metadata.triggers ?? "")
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 20);
}

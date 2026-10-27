/**
 * 编辑器命令系统（命令模式）：工具条、快捷键、命令面板（Ctrl+K）、径向轮盘、右键菜单共用一张命令表。
 *
 * 本文件只有纯逻辑：命令的形状、快捷键（chord）的规整与匹配、模糊搜索与冲突检测。
 * 命令的注册与执行见 `hooks/useEditorCommands.ts`。
 */

/** 命令分类（命令面板里的分组与匹配依据）。 */
export type CommandCategory = "file" | "edit" | "transport" | "timeline" | "view" | "insert" | "output" | "select";

/** 一个命令。 */
export interface Command {
  /** 全局唯一，例如 `timeline.split` */
  id: string;
  /** 标题文案键 */
  titleKey: string;
  category: CommandCategory;
  /** 默认快捷键（规整后的 chord，例如 `mod+b`、`shift+arrowright`、`space`） */
  keys?: readonly string[];
  /** 当前是否可用；不可用时快捷键不触发、命令面板里置灰 */
  enabled?: () => boolean;
  /** 执行 */
  run: () => void;
  /** 在文本输入框里也响应快捷键（例如保存） */
  global?: boolean;
}

/** 键盘事件里与 chord 有关的字段。 */
export interface ChordEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** `KeyboardEvent.key` 的别名规整（小写；空格写作 `space`）。 */
const KEY_ALIASES: Record<string, string> = {
  " ": "space",
  spacebar: "space",
  esc: "escape",
  del: "delete",
  plus: "+",
  "=": "+",
  add: "+",
  subtract: "-",
  minus: "-",
};

/**
 * 规整一个键名。
 *
 * @param key `KeyboardEvent.key` 或手写的键名。
 * @returns 小写键名。
 */
function normalizeKey(key: string): string {
  const k = key.length === 1 ? key.toLowerCase() : key.toLowerCase();
  return KEY_ALIASES[k] ?? k;
}

/**
 * 由键盘事件得到规整的 chord：修饰键按 `mod`（Ctrl / ⌘）、`alt`、`shift` 的固定顺序，最后是键名。
 *
 * @param e 键盘事件。
 * @returns 例如 `mod+shift+z`；只按了修饰键时为空串。
 */
export function chordOf(e: ChordEvent): string {
  const key = normalizeKey(e.key);
  if (["control", "meta", "shift", "alt", "os"].includes(key)) return "";
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("mod");
  if (e.altKey) parts.push("alt");
  // 已经由 Shift 产生的符号（例如 `+`）不再重复记 shift
  if (e.shiftKey && !(key.length === 1 && /[^a-z0-9]/.test(key))) parts.push("shift");
  parts.push(key);
  return parts.join("+");
}

/**
 * 规整手写的 chord（大小写、修饰键顺序、别名）。
 *
 * @param chord 例如 `Ctrl+Shift+Z`、`mod+b`。
 * @returns 规整后的 chord；无法识别时为空串。
 */
export function parseChord(chord: string): string {
  const raw = chord.trim();
  if (raw === "") return "";
  // 末尾的 `+` 本身是键名（例如 `mod++`）
  const plusKey = raw.endsWith("++") || raw === "+";
  const parts = (plusKey ? raw.slice(0, -1) : raw).split("+").map((p) => p.trim().toLowerCase()).filter(Boolean);
  const mods = new Set<string>();
  let key = plusKey ? "+" : "";
  for (const p of parts) {
    if (p === "ctrl" || p === "control" || p === "cmd" || p === "meta" || p === "mod") mods.add("mod");
    else if (p === "alt" || p === "option") mods.add("alt");
    else if (p === "shift") mods.add("shift");
    else key = normalizeKey(p);
  }
  if (key === "") return "";
  return [...["mod", "alt", "shift"].filter((m) => mods.has(m)), key].join("+");
}

/**
 * 把 chord 格式化成给人看的文字（Windows / Linux 风格）。
 *
 * @param chord 规整后的 chord。
 * @returns 例如 `Ctrl+Shift+Z`、`Space`、`→`。
 */
export function formatChord(chord: string): string {
  const names: Record<string, string> = {
    mod: "Ctrl",
    alt: "Alt",
    shift: "Shift",
    space: "Space",
    arrowleft: "←",
    arrowright: "→",
    arrowup: "↑",
    arrowdown: "↓",
    escape: "Esc",
    delete: "Del",
    backspace: "Backspace",
    enter: "Enter",
    home: "Home",
    end: "End",
  };
  return chord
    .split("+")
    .map((p, i, all) => (p === "" && i === all.length - 1 ? "+" : names[p] ?? p.toUpperCase()))
    .filter((p) => p !== "")
    .join("+");
}

/** 用户自定义的快捷键：命令 id → chord 列表（空数组表示取消该命令的快捷键）。 */
export type KeymapOverrides = Readonly<Record<string, readonly string[]>>;

/**
 * 命令实际生效的快捷键：有自定义时用自定义，否则用默认。
 *
 * @param command 命令。
 * @param overrides 用户自定义。
 * @returns 规整后的 chord 列表。
 */
export function effectiveKeys(command: Pick<Command, "id" | "keys">, overrides: KeymapOverrides): string[] {
  const keys = overrides[command.id] ?? command.keys ?? [];
  return keys.map(parseChord).filter(Boolean);
}

/**
 * 找出被多个命令占用的快捷键。
 *
 * @param commands 全部命令。
 * @param overrides 用户自定义。
 * @returns `[chord, 命令 id 列表]`，只含冲突的项。
 */
export function findConflicts(
  commands: readonly Pick<Command, "id" | "keys">[],
  overrides: KeymapOverrides,
): [string, string[]][] {
  const byChord = new Map<string, string[]>();
  for (const c of commands) {
    for (const k of effectiveKeys(c, overrides)) {
      const list = byChord.get(k) ?? [];
      list.push(c.id);
      byChord.set(k, list);
    }
  }
  return [...byChord].filter(([, ids]) => ids.length > 1);
}

/**
 * 按键盘事件找到要执行的命令（第一个匹配且可用的）。
 *
 * @param commands 全部命令。
 * @param overrides 用户自定义。
 * @param e 键盘事件。
 * @param inTextEntry 焦点是否在文本输入框里（此时只匹配 `global` 命令）。
 * @returns 命令；没有匹配时为 `null`。
 */
export function matchCommand(
  commands: readonly Command[],
  overrides: KeymapOverrides,
  e: ChordEvent,
  inTextEntry: boolean,
): Command | null {
  const chord = chordOf(e);
  if (chord === "") return null;
  for (const c of commands) {
    if (inTextEntry && !c.global) continue;
    if (!effectiveKeys(c, overrides).includes(chord)) continue;
    if (c.enabled && !c.enabled()) continue;
    return c;
  }
  return null;
}

/** 模糊匹配结果。 */
export interface FuzzyMatch {
  score: number;
  /** 命中的字符下标（用于高亮） */
  indices: number[];
}

/**
 * 模糊匹配：查询的每个字符按顺序出现在文本里即命中（不要求连续），例如 `bfz` 能匹配“播放 / 暂停”的拼音首字母不行，
 * 但 `fzz` 能匹配 `fit zoom`。
 *
 * 打分：词首命中、连续命中加分；越早命中越好；完全前缀额外加分。大小写不敏感。
 *
 * @param query 查询（空串匹配一切，分数为 0）。
 * @param text 被搜索的文本。
 * @returns 命中时给出分数与下标；否则为 `null`。
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.trim().toLowerCase();
  if (q === "") return { score: 0, indices: [] };
  const t = text.toLowerCase();
  const indices: number[] = [];
  let score = 0;
  let from = 0;
  let prev = -2;
  for (const ch of q) {
    if (ch === " ") continue;
    const at = t.indexOf(ch, from);
    if (at < 0) return null;
    const wordStart = at === 0 || /[\s\-_/.·（(]/.test(t[at - 1]);
    score += 1;
    if (wordStart) score += 3;
    if (at === prev + 1) score += 2;
    score -= Math.min(at, 20) * 0.05;
    indices.push(at);
    prev = at;
    from = at + 1;
  }
  if (t.startsWith(q)) score += 5;
  return { score, indices };
}

/** 排好序的命令搜索结果。 */
export interface RankedCommand {
  command: Command;
  title: string;
  match: FuzzyMatch;
}

/**
 * 搜索命令：标题与分类名都参与匹配，按分数从高到低排序（同分按标题）。
 *
 * @param commands 全部命令。
 * @param query 查询。
 * @param title 取命令的显示标题。
 * @param categoryName 取分类的显示名。
 * @returns 命中的命令。
 */
export function rankCommands(
  commands: readonly Command[],
  query: string,
  title: (c: Command) => string,
  categoryName: (c: Command) => string,
): RankedCommand[] {
  const out: RankedCommand[] = [];
  for (const command of commands) {
    const t = title(command);
    const byTitle = fuzzyMatch(query, t);
    const byCategory = byTitle ? null : fuzzyMatch(query, `${categoryName(command)} ${t}`);
    const match = byTitle ?? (byCategory ? { score: byCategory.score - 2, indices: [] } : null);
    if (match) out.push({ command, title: t, match });
  }
  return out.sort((a, b) => b.match.score - a.match.score || a.title.localeCompare(b.title));
}

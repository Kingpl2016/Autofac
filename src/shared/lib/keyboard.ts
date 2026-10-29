/**
 * 键盘快捷键的公共逻辑：判断焦点是否在自己处理按键的元素上，以及快捷键（chord）的规整与显示。
 */

/**
 * 焦点是否在文本输入控件里（输入框、文本域、下拉框、可编辑区域）。
 * 此时 `/`、Ctrl+Z 这类快捷键应交给控件自己。
 *
 * @param target 键盘事件目标。
 * @returns 是文本输入控件时为 `true`。
 */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable === true;
}

/** 自己处理空格 / 方向键的元素。 */
const INTERACTIVE_SELECTOR =
  'input, textarea, select, button, summary, a[href], [role="slider"], [role="switch"], [role="radio"], [role="tab"], [role="combobox"], [role="dialog"]';

/**
 * 焦点所在的元素是否自己处理键盘输入（输入框、按钮、单选、滑块、标签页、下拉、对话框……）。
 * 这些元素上按空格 / 方向键有它们自己的含义，页面级快捷键（播放 / 暂停、跳转）不应该抢。
 *
 * @param target 键盘事件目标。
 * @returns 目标是（或位于）会自行处理按键的元素内时为 `true`。
 */
export function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.closest(INTERACTIVE_SELECTOR) !== null;
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

/** 规整一个键名（小写、别名）。 */
function normalizeKey(key: string): string {
  const k = key.toLowerCase();
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

/** chord 各部分给人看的名字（Windows / Linux 风格）。 */
const CHORD_NAMES: Record<string, string> = {
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

/**
 * 把 chord 格式化成给人看的文字。
 *
 * @param chord 规整后的 chord。
 * @returns 例如 `Ctrl+Shift+Z`、`Space`、`→`。
 */
export function formatChord(chord: string): string {
  return chord
    .split("+")
    .map((p, i, all) => (p === "" && i === all.length - 1 ? "+" : CHORD_NAMES[p] ?? p.toUpperCase()))
    .filter((p) => p !== "")
    .join("+");
}

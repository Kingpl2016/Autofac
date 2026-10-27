import type { TFunction } from "i18next";

import type { Protocol } from "@/shared/domain/engine";
import { MAX_UNIVERSE, buildFileStem, expandRanges } from "./filter";
import type { RecordFilter, RecordingStartArgs, UniverseRange } from "./types";

/**
 * 当前录制预设：录制页、顶栏录制按钮与全局快捷键共用的一份录制配置。
 *
 * 过滤条件三类取交集，空数组表示该维度不限制；名称模板里的 `{n}` / `{nn}` / `{nnn}`
 * 会替换为序号（后两种补零），每次成功开始录制后序号加一。
 */
export interface RecordingPreset {
  /** 来源 IP 集合 */
  sources: string[];
  /** true 时 `sources` 为黑名单 */
  excludeSources: boolean;
  /** Universe 范围过滤（规整后的片段，如 `0-3`、`10`） */
  universeTokens: string[];
  /** 额外包含的 Universe（尚无信号、需要预先纳入录制的） */
  extraTokens: string[];
  /** 允许的协议；两个都选等价于不限制，至少保留一个 */
  protocols: Protocol[];
  /** 节目名称模板 */
  nameTemplate: string;
  /** 下一次录制使用的序号（从 1 起） */
  nextIndex: number;
}

/** 全部协议（显示顺序）。 */
export const ALL_PROTOCOLS: readonly Protocol[] = ["artNet", "sacn"];
/** 名称模板最大长度。 */
export const MAX_TEMPLATE_LENGTH = 80;
/** 序号上限。 */
export const MAX_INDEX = 99_999;

/** 默认预设：全量采集，名称为空（文件名只用时间戳），序号从 1 起。 */
export const EMPTY_PRESET: RecordingPreset = {
  sources: [],
  excludeSources: false,
  universeTokens: [],
  extraTokens: [],
  protocols: [...ALL_PROTOCOLS],
  nameTemplate: "",
  nextIndex: 1,
};

// ---------------------------------------------------------------------------
// Universe 片段
// ---------------------------------------------------------------------------

/** 单个 Universe 片段的解析结果。 */
export type UniverseTokenResult =
  | { ok: true; label: string; range: UniverseRange }
  | { ok: false; reason: "syntax" | "outOfRange" };

const TOKEN_RE = /^(\d+)(?:\s*[-~–]\s*(\d+))?$/;

/**
 * 解析一个 Universe 片段（`10` 或 `0-3`，也接受 `~` / `–` 作连接符）。
 *
 * - 反向范围自动交换；
 * - 起点超出 ArtRec 可表示范围（> 2047）视为非法；终点超出时截到 2047。
 *
 * @param raw 用户输入的一个片段。
 * @returns 规整后的标签与范围，或失败原因。
 */
export function parseUniverseToken(raw: string): UniverseTokenResult {
  const m = TOKEN_RE.exec(raw.trim());
  if (!m) return { ok: false, reason: "syntax" };
  const a = Number(m[1]);
  const b = m[2] === undefined ? a : Number(m[2]);
  const start = Math.min(a, b);
  const end = Math.min(Math.max(a, b), MAX_UNIVERSE);
  if (start > MAX_UNIVERSE) return { ok: false, reason: "outOfRange" };
  return {
    ok: true,
    label: start === end ? String(start) : `${start}-${end}`,
    range: { start, end },
  };
}

/**
 * 把一段输入（可能是粘贴的 `0-3, 10 abc`）拆成片段。
 *
 * @param text 输入文本。
 * @returns 去掉空白后的片段列表（保持原顺序）。
 */
export function splitUniverseInput(text: string): string[] {
  return text
    .split(/[,，;；\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 把片段标签列表转成范围列表（非法片段被忽略）。
 *
 * @param tokens 片段标签。
 */
export function tokensToRanges(tokens: readonly string[]): UniverseRange[] {
  const out: UniverseRange[] = [];
  for (const tok of tokens) {
    const r = parseUniverseToken(tok);
    if (r.ok) out.push(r.range);
  }
  return out;
}

/** 规整片段列表：只保留合法片段，按标签去重。 */
function normalizeTokens(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const r = parseUniverseToken(v);
    if (r.ok) seen.add(r.label);
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// 名称模板
// ---------------------------------------------------------------------------

const INDEX_RE = /\{(n{1,3})\}/g;

/**
 * 模板里是否含序号占位符。
 *
 * @param template 名称模板。
 */
export function hasIndexPlaceholder(template: string): boolean {
  return /\{n{1,3}\}/.test(template);
}

/**
 * 按序号渲染名称模板：`{n}` → `4`，`{nn}` → `04`，`{nnn}` → `004`。
 *
 * @param template 名称模板（为空时结果为空，文件名只用时间戳）。
 * @param index 序号。
 * @returns 渲染后的节目名称（已去掉首尾空白）。
 */
export function renderNameTemplate(template: string, index: number): string {
  return template
    .replace(INDEX_RE, (_m, ns: string) => String(index).padStart(ns.length, "0"))
    .trim();
}

// ---------------------------------------------------------------------------
// 预设 → 录制参数
// ---------------------------------------------------------------------------

/**
 * 预设对应的录制过滤条件（与后端 `RecordFilter` 一致）。
 *
 * sACN 关闭时协议过滤界面被隐藏，一律不限制协议，避免此前取消勾选 Art-Net 的状态
 * 在看不见的地方继续生效；两个协议都选也等价于不限制。
 *
 * @param preset 录制预设。
 * @param sacnEnabled 是否启用 sACN。
 */
export function presetToFilter(preset: RecordingPreset, sacnEnabled: boolean): RecordFilter {
  const chosen = ALL_PROTOCOLS.filter((p) => preset.protocols.includes(p));
  return {
    sources: [...preset.sources],
    excludeSources: preset.excludeSources,
    universes: tokensToRanges(preset.universeTokens),
    protocols: !sacnEnabled || chosen.length === ALL_PROTOCOLS.length ? [] : chosen,
  };
}

/**
 * 预设里“额外包含”的 Universe（展开、去重、升序）。
 *
 * @param preset 录制预设。
 */
export function presetExtraUniverses(preset: RecordingPreset): number[] {
  return expandRanges(tokensToRanges(preset.extraTokens));
}

/**
 * 预设是否带有过滤（来源 / Universe 范围 / 协议任一维度有限制）。
 * “额外包含”只会多录，不算过滤。
 *
 * @param preset 录制预设。
 * @param sacnEnabled 是否启用 sACN。
 */
export function isPresetFiltered(preset: RecordingPreset, sacnEnabled: boolean): boolean {
  const f = presetToFilter(preset, sacnEnabled);
  return f.sources.length > 0 || f.universes.length > 0 || f.protocols.length > 0;
}

interface StartArgsOptions {
  /** 开始时刻（用于文件名时间戳） */
  now: Date;
  /** 仅本次有效的备注 */
  notes?: string;
  /** 是否启用 sACN */
  sacnEnabled: boolean;
}

/**
 * 由预设构造 `recording_start` 参数。
 *
 * @param preset 录制预设。
 * @param opts 开始时刻、备注与协议开关。
 */
export function buildStartArgs(preset: RecordingPreset, opts: StartArgsOptions): RecordingStartArgs {
  const name = renderNameTemplate(preset.nameTemplate, preset.nextIndex);
  return {
    name,
    notes: (opts.notes ?? "").trim(),
    fileStem: buildFileStem(opts.now, name),
    filter: presetToFilter(preset, opts.sacnEnabled),
    universes: presetExtraUniverses(preset),
  };
}

// ---------------------------------------------------------------------------
// 摘要与校验
// ---------------------------------------------------------------------------

/** 片段列表过长时截断。 */
function joinTokens(tokens: readonly string[], max = 4): string {
  return tokens.length <= max
    ? tokens.join(", ")
    : `${tokens.slice(0, max).join(", ")} +${tokens.length - max}`;
}

/** 协议显示名。 */
export function protocolName(p: Protocol): string {
  return p === "sacn" ? "sACN" : "Art-Net";
}

/**
 * 预设的一行摘要（若干短语，界面用“·”连接）。
 *
 * @param preset 录制预设。
 * @param sacnEnabled 是否启用 sACN（关闭时不提协议）。
 * @param t 翻译函数。
 */
export function describePreset(
  preset: RecordingPreset,
  sacnEnabled: boolean,
  t: TFunction,
): string[] {
  const parts: string[] = [];
  const n = preset.sources.length;
  parts.push(
    n === 0
      ? t("recording.presetSourcesAll")
      : preset.excludeSources
        ? t("recording.presetSourcesExcluding", { n })
        : t("recording.presetSourcesOnly", { n }),
  );
  parts.push(
    preset.universeTokens.length === 0
      ? t("recording.presetUniversesAll")
      : t("recording.presetUniverses", { list: joinTokens(preset.universeTokens) }),
  );
  if (preset.extraTokens.length > 0) {
    parts.push(t("recording.presetExtra", { list: joinTokens(preset.extraTokens) }));
  }
  const f = presetToFilter(preset, sacnEnabled);
  if (f.protocols.length > 0) {
    parts.push(t("recording.presetProtocolOnly", { name: f.protocols.map(protocolName).join(" + ") }));
  }
  return parts;
}

/**
 * 校验并规整从磁盘读回的预设：任何字段不合法都回落到当前值，
 * 避免旧版本文件或被手改的文件让录制进入无效状态。
 *
 * @param raw 磁盘上读到的未知数据。
 * @param current 当前内存中的预设（作为非法字段的回退）。
 * @returns 一定合法的预设。
 */
export function sanitizePreset(raw: unknown, current: RecordingPreset): RecordingPreset {
  const r = (raw ?? {}) as Partial<Record<keyof RecordingPreset, unknown>>;
  const sources = Array.isArray(r.sources)
    ? [...new Set(r.sources.filter((v): v is string => typeof v === "string" && v.trim() !== ""))]
    : current.sources;
  const protocols = Array.isArray(r.protocols)
    ? ALL_PROTOCOLS.filter((p) => (r.protocols as unknown[]).includes(p))
    : current.protocols;
  const index = Number(r.nextIndex);
  return {
    sources,
    excludeSources:
      typeof r.excludeSources === "boolean" ? r.excludeSources : current.excludeSources,
    universeTokens: Array.isArray(r.universeTokens)
      ? normalizeTokens(r.universeTokens)
      : current.universeTokens,
    extraTokens: Array.isArray(r.extraTokens) ? normalizeTokens(r.extraTokens) : current.extraTokens,
    protocols: protocols.length > 0 ? protocols : [...ALL_PROTOCOLS],
    nameTemplate:
      typeof r.nameTemplate === "string"
        ? r.nameTemplate.slice(0, MAX_TEMPLATE_LENGTH)
        : current.nameTemplate,
    nextIndex:
      Number.isInteger(index) && index >= 1 && index <= MAX_INDEX ? index : current.nextIndex,
  };
}

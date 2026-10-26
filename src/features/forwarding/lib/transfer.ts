import {
  firstError,
  hasErrors,
  validateDestination,
  type ValidationCode,
} from "./validate";
import type { ForwardDestination, UniverseOverride } from "./types";

/** 导入阶段额外的结构错误码，对应 i18n 键 `forwarding.error.<code>`。 */
export type ImportItemCode =
  | ValidationCode
  | "typeInvalid"
  | "protocolInvalid"
  | "modeInvalid"
  | "actionInvalid";

/** 导入失败原因。`index` 为 1 起算的目的地序号。 */
export type ImportError =
  | { kind: "json" }
  | { kind: "shape" }
  | { kind: "empty" }
  | { kind: "item"; index: number; field: string; code: ImportItemCode };

/** 导入解析结果。 */
export type ImportResult =
  | { ok: true; destinations: ForwardDestination[] }
  | { ok: false; error: ImportError };

type ItemFailure = { field: string; code: ImportItemCode };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 数值字段：缺省用默认值；存在但不是数字则判为类型错误。 */
function num(v: unknown, fallback: number): number | null {
  if (v === undefined) return fallback;
  return typeof v === "number" ? v : null;
}

/** 可空数值字段：`undefined` / `null` 都视为未设置。 */
function optNum(v: unknown): number | null | "bad" {
  if (v === undefined || v === null) return null;
  return typeof v === "number" ? v : "bad";
}

function normalizeOverride(raw: unknown): UniverseOverride | ItemFailure {
  if (!isObj(raw)) return { field: "overrides", code: "typeInvalid" };
  const sourceUniverse = num(raw.sourceUniverse, Number.NaN);
  if (sourceUniverse === null) return { field: "overrides", code: "typeInvalid" };
  if (raw.action !== "forward" && raw.action !== "exclude") {
    return { field: "overrides", code: "actionInvalid" };
  }
  const targetUniverse = optNum(raw.targetUniverse);
  const delayMs = optNum(raw.delayMs);
  if (targetUniverse === "bad" || delayMs === "bad") {
    return { field: "overrides", code: "typeInvalid" };
  }
  return { sourceUniverse, action: raw.action, targetUniverse, delayMs };
}

function normalizeItem(raw: unknown): ForwardDestination | ItemFailure {
  if (!isObj(raw)) return { field: "item", code: "typeInvalid" };
  if (typeof raw.name !== "string") return { field: "name", code: "nameRequired" };
  if (typeof raw.targetIp !== "string") return { field: "targetIp", code: "ipRequired" };
  if (raw.protocol !== "artNet" && raw.protocol !== "sacn") {
    return { field: "protocol", code: "protocolInvalid" };
  }
  if (raw.mode !== "all" && raw.mode !== "selected") {
    return { field: "mode", code: "modeInvalid" };
  }
  const port = num(raw.port, raw.protocol === "sacn" ? 5568 : 6454);
  const universeOffset = num(raw.universeOffset, 0);
  const defaultDelayMs = num(raw.defaultDelayMs, 0);
  if (port === null) return { field: "port", code: "portInvalid" };
  if (universeOffset === null) return { field: "universeOffset", code: "offsetInvalid" };
  if (defaultDelayMs === null) return { field: "defaultDelayMs", code: "delayInvalid" };
  if (raw.description !== undefined && typeof raw.description !== "string") {
    return { field: "description", code: "typeInvalid" };
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    return { field: "enabled", code: "typeInvalid" };
  }
  const rawOverrides = raw.overrides ?? [];
  if (!Array.isArray(rawOverrides)) return { field: "overrides", code: "typeInvalid" };
  const overrides: UniverseOverride[] = [];
  for (const o of rawOverrides) {
    const n = normalizeOverride(o);
    if ("field" in n) return n;
    overrides.push(n);
  }
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : crypto.randomUUID(),
    name: raw.name,
    targetIp: raw.targetIp,
    protocol: raw.protocol,
    port,
    mode: raw.mode,
    universeOffset,
    defaultDelayMs,
    description: typeof raw.description === "string" ? raw.description : "",
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
    overrides,
  };
}

/**
 * 解析并校验导入文件。
 *
 * 接受两种顶层形式：目的地数组（本应用导出的格式），或 `{ "destinations": [...] }`。
 * 缺省字段按默认值补齐；任何一项结构或取值不合法就整体拒绝，并指出第几项的哪个字段。
 * 文件内重复的 id 会被换成新 id。
 *
 * @param text 文件内容。
 * @returns 成功时给出规整后的目的地列表，失败时给出原因。
 */
export function parseImport(text: string): ImportResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: { kind: "json" } };
  }
  const list = Array.isArray(data) ? data : isObj(data) ? data.destinations : undefined;
  if (!Array.isArray(list)) return { ok: false, error: { kind: "shape" } };
  if (list.length === 0) return { ok: false, error: { kind: "empty" } };

  const out: ForwardDestination[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < list.length; i += 1) {
    const n = normalizeItem(list[i]);
    if ("field" in n) return { ok: false, error: { kind: "item", index: i + 1, ...n } };
    const errors = validateDestination(n);
    if (hasErrors(errors)) {
      const first = firstError(errors);
      if (first) return { ok: false, error: { kind: "item", index: i + 1, ...first } };
    }
    out.push(seen.has(n.id) ? { ...n, id: crypto.randomUUID() } : n);
    seen.add(out[out.length - 1].id);
  }
  return { ok: true, destinations: out };
}

/**
 * 把导入的目的地合并进现有列表（追加在末尾）；与现有条目 id 冲突的换成新 id。
 *
 * @param current 当前列表。
 * @param imported 已通过 {@link parseImport} 的导入列表。
 * @returns 合并后的新列表，不修改入参。
 */
export function mergeImported(
  current: readonly ForwardDestination[],
  imported: readonly ForwardDestination[],
): ForwardDestination[] {
  const used = new Set(current.map((d) => d.id));
  const added = imported.map((d) => {
    const id = used.has(d.id) ? crypto.randomUUID() : d.id;
    used.add(id);
    return id === d.id ? d : { ...d, id };
  });
  return [...current, ...added];
}
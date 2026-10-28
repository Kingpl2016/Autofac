import { isUnspecifiedIpv4, isValidIpv4 } from "@/shared/lib/ip";
import type { ForwardDestination, UniverseOverride } from "./types";

/** 校验错误码，对应 i18n 键 `forwarding.error.<code>`。 */
export type ValidationCode =
  | "nameRequired"
  | "ipRequired"
  | "ipInvalid"
  | "ipUnspecified"
  | "portInvalid"
  | "offsetInvalid"
  | "delayInvalid"
  | "overrideSource"
  | "overrideTarget"
  | "overrideDelay";

/** 目的地级别的字段。 */
export type DestinationField =
  | "name"
  | "targetIp"
  | "port"
  | "universeOffset"
  | "defaultDelayMs";

/** 单条覆盖规则的字段错误。 */
export interface OverrideErrors {
  sourceUniverse?: ValidationCode;
  targetUniverse?: ValidationCode;
  delayMs?: ValidationCode;
}

/** 一个目的地的校验结果；没有错误的字段不出现。 */
export interface DestinationErrors {
  fields: Partial<Record<DestinationField, ValidationCode>>;
  /** 键为覆盖规则在数组中的下标。 */
  overrides: Record<number, OverrideErrors>;
}

/** 默认延迟 / 覆盖延迟的上限（毫秒），与后端 `default_delay_ms` 约定一致。 */
export const MAX_DELAY_MS = 2000;
/** Universe 编号上限（后端为 `u16`）。 */
export const MAX_UNIVERSE = 65535;

const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);
const inRange = (n: unknown, lo: number, hi: number): boolean => isInt(n) && n >= lo && n <= hi;

function validateOverride(o: UniverseOverride): OverrideErrors {
  const e: OverrideErrors = {};
  if (!inRange(o.sourceUniverse, 0, MAX_UNIVERSE)) e.sourceUniverse = "overrideSource";
  if (o.targetUniverse != null && !inRange(o.targetUniverse, 0, MAX_UNIVERSE)) {
    e.targetUniverse = "overrideTarget";
  }
  if (o.delayMs != null && !inRange(o.delayMs, 0, MAX_DELAY_MS)) e.delayMs = "overrideDelay";
  return e;
}

/**
 * 校验一个转发目的地。
 *
 * 规则：名称非空；目标 IP 必须是 IPv4（发送套接字为 IPv4），且不能是 `0.0.0.0`（只能用于绑定）；端口 1 到 65535；
 * Universe 偏移为整数且绝对值不超过 65535；默认延迟 0 到 2000 ms；
 * 覆盖规则的源 / 目标 Universe 在 0 到 65535，延迟在 0 到 2000 ms。
 *
 * @param d 待校验的目的地。
 * @returns 各字段的错误码；全部合法时 `fields` 与 `overrides` 均为空。
 */
export function validateDestination(d: ForwardDestination): DestinationErrors {
  const fields: DestinationErrors["fields"] = {};
  if (!d.name.trim()) fields.name = "nameRequired";
  const ip = d.targetIp.trim();
  if (!ip) fields.targetIp = "ipRequired";
  else if (!isValidIpv4(ip)) fields.targetIp = "ipInvalid";
  else if (isUnspecifiedIpv4(ip)) fields.targetIp = "ipUnspecified";
  if (!inRange(d.port, 1, 65535)) fields.port = "portInvalid";
  if (!inRange(d.universeOffset, -MAX_UNIVERSE, MAX_UNIVERSE)) fields.universeOffset = "offsetInvalid";
  if (!inRange(d.defaultDelayMs, 0, MAX_DELAY_MS)) fields.defaultDelayMs = "delayInvalid";

  const overrides: DestinationErrors["overrides"] = {};
  d.overrides.forEach((o, i) => {
    const e = validateOverride(o);
    if (Object.keys(e).length > 0) overrides[i] = e;
  });
  return { fields, overrides };
}

/**
 * 是否存在任何校验错误。
 *
 * @param e {@link validateDestination} 的结果。
 * @returns 有错误为 `true`。
 */
export function hasErrors(e: DestinationErrors): boolean {
  return Object.keys(e.fields).length > 0 || Object.keys(e.overrides).length > 0;
}

/**
 * 找出第一处错误，供导入时给出“哪一项哪个字段”的提示。
 *
 * @param e {@link validateDestination} 的结果。
 * @returns 第一处错误的字段标识与错误码；没有错误返回 `null`。
 */
export function firstError(
  e: DestinationErrors,
): { field: string; code: ValidationCode } | null {
  const order: DestinationField[] = ["name", "targetIp", "port", "universeOffset", "defaultDelayMs"];
  for (const f of order) {
    const code = e.fields[f];
    if (code) return { field: f, code };
  }
  for (const [i, o] of Object.entries(e.overrides)) {
    const code = o.sourceUniverse ?? o.targetUniverse ?? o.delayMs;
    if (code) return { field: `overrides[${i}]`, code };
  }
  return null;
}
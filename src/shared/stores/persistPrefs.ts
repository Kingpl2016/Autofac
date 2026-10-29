import type { z } from "zod";
import type { PersistOptions } from "zustand/middleware";

import { createTauriPersistStorage } from "@/shared/tauri/tauriStorage";

/**
 * 由逐字段兜底的 zod schema 得到“读回数据的清洗函数”：任何字段不合法都回落到 schema 里的默认值
 * （每个字段用 `.catch(默认值)`），整体不是对象时按空对象处理。
 *
 * @param schema 偏好的 schema（每个字段都要有 `.catch`，保证不会抛出）。
 * @returns 清洗函数。
 */
export function prefsSanitizer<T>(schema: z.ZodType<T>): (raw: unknown) => T {
  return (raw) => {
    const parsed = schema.safeParse(raw ?? {});
    return parsed.success ? parsed.data : schema.parse({});
  };
}

/** `persistPrefs` 的参数。 */
export interface PersistPrefsOptions<P extends object> {
  /** 落盘文件里的键（已有用户数据，不能改）。 */
  name: string;
  /** 数据版本（已有用户数据，不能随意改）。 */
  version: number;
  /** 要落盘的字段及其兜底规则（`z.object`，每个字段带 `.catch`）。 */
  schema: z.ZodType<P> & { shape: Record<string, unknown> };
  /** 落盘文件；默认是界面偏好文件 `ui-prefs.json`。 */
  file?: string;
}

/**
 * 生成界面偏好 store 的 zustand `persist` 配置：经 Tauri Store 落盘、只保存 schema 里的字段、
 * 读回时逐字段清洗（不合法的字段回落默认值），没有已保存数据时保持当前值。
 *
 * @param options 键名、版本、schema 与文件。
 * @returns `persist(..., options)` 的第二个参数。
 */
export function persistPrefs<S extends P, P extends object>({
  name,
  version,
  schema,
  file,
}: PersistPrefsOptions<P>): PersistOptions<S, P> {
  const keys = Object.keys(schema.shape) as (keyof P)[];
  const sanitize = prefsSanitizer(schema);
  return {
    name,
    version,
    storage: createTauriPersistStorage<P>(file),
    partialize: (state) => Object.fromEntries(keys.map((k) => [k, state[k]])) as P,
    // 没有已保存的数据（首次运行 / 读取失败）时保持当前值，不被默认值覆盖
    merge: (persisted, current) => (persisted == null ? current : { ...current, ...sanitize(persisted) }),
  };
}

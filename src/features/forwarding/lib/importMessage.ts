import type { TFunction } from "i18next";

import type { ImportError } from "./transfer";

/** 导入错误里的字段标识对应的本地化字段名。 */
const FIELD_KEYS: Record<string, string> = {
  name: "forwarding.name",
  targetIp: "forwarding.targetIp",
  protocol: "forwarding.protocol",
  port: "forwarding.port",
  mode: "forwarding.mode",
  universeOffset: "forwarding.universeOffset",
  defaultDelayMs: "forwarding.defaultDelay",
  description: "forwarding.description",
  enabled: "forwarding.enabled",
  overrides: "forwarding.overrides",
  item: "forwarding.import.itemField",
};

/**
 * 把导入错误转成给用户看的一句话，指明第几项的哪个字段以及原因。
 *
 * @param error {@link ImportError}。
 * @param t i18n 翻译函数。
 * @returns 本地化的错误描述。
 */
export function describeImportError(error: ImportError, t: TFunction): string {
  switch (error.kind) {
    case "json":
      return t("forwarding.import.errorJson");
    case "shape":
      return t("forwarding.import.errorShape");
    case "empty":
      return t("forwarding.import.errorEmpty");
    case "item": {
      // 覆盖规则的字段标识形如 `overrides[2]`，只取字段名部分
      const base = error.field.replace(/\[\d+\]$/, "");
      const fieldKey = FIELD_KEYS[base];
      return t("forwarding.import.errorItem", {
        index: error.index,
        field: fieldKey ? t(fieldKey) : error.field,
        detail: t(`forwarding.error.${error.code}`),
      });
    }
  }
}
import type { TFunction } from "i18next";

/**
 * 把后端返回的错误码（字符串）转成本地化文案。
 *
 * 后端错误码见 `src-tauri/src/fixture_commands.rs`：`bad_path`、`file_too_large`、
 * `import_failed:<open|no_models>`、`builtin_readonly`、`not_found`、`io`、`invalid_model:<原因>`。
 *
 * @param t 翻译函数。
 * @param error 被 reject 的值。
 * @returns 可直接展示给用户的文案。
 */
export function fixtureErrorText(t: TFunction, error: unknown): string {
  const raw = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  if (raw.startsWith("invalid_model:")) {
    return t("fixtures.errors.invalidModel", { reason: raw.slice("invalid_model:".length) });
  }
  switch (raw) {
    case "bad_path":
    case "file_too_large":
    case "builtin_readonly":
    case "not_found":
    case "io":
      return t(`fixtures.errors.${raw}`);
    case "import_failed:open":
      return t("fixtures.errors.importOpen");
    case "import_failed:no_models":
      return t("fixtures.errors.importNoModels");
    default:
      return t("common.unknownError");
  }
}

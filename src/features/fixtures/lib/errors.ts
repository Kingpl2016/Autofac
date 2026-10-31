import type { TFunction } from "i18next";

/**
 * 把后端返回的错误码（字符串）转成本地化文案。
 *
 * 后端错误码见 `src-tauri/src/fixture_commands.rs`：`bad_path`、`file_too_large`、
 * `import_failed:<open|no_models>`、`import_failed:redirect:<制造商/灯具>`、`builtin_readonly`、`not_found`、`io`、
 * `invalid_model:<原因>`。
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
  if (raw.startsWith("import_failed:redirect:")) {
    return t("fixtures.errors.importRedirect", { target: raw.slice("import_failed:redirect:".length) });
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
    case "bundle_open":
    case "bundle_empty":
    case "bundle_too_large":
    case "bundle_not_found":
    case "catalog_stale":
    case "catalog_missing":
      return t(`fixtures.errors.${raw}`);
    default:
      return t("common.unknownError");
  }
}

/**
 * 资源库（图标 / 3D 模型）的错误码转成本地化文案。
 *
 * 后端错误码见 `src-tauri/src/fixture_asset_commands.rs`：`bad_path`、`bad_format`、`too_large`、
 * `unsafe_svg`、`full`、`not_found`、`io`、`bad_request`。
 *
 * @param t 翻译函数。
 * @param error 被 reject 的值。
 * @returns 可直接展示给用户的文案。
 */
export function assetErrorText(t: TFunction, error: unknown): string {
  const raw = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  switch (raw) {
    case "bad_path":
    case "bad_format":
    case "too_large":
    case "unsafe_svg":
    case "full":
    case "not_found":
    case "io":
      return t(`fixtures.assets.errors.${raw}`);
    default:
      return raw || t("common.unknownError");
  }
}

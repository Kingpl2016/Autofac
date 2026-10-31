/**
 * 3D 文件导入错误 → 文案（灯具模型与场馆模型的导入对话框共用）。
 *
 * @param t 翻译函数。
 * @param e 异常。
 * @returns 文案。
 */
export function importErrorText(t: (k: string, o?: Record<string, unknown>) => string, e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  if (raw === "no_mesh" || raw === "too_large" || raw === "bad_path" || raw === "bad_format") return t(`editor.stage3d.importErrors.${raw}`);
  if (/draco/i.test(raw)) return t("editor.stage3d.importErrors.draco");
  return t("editor.stage3d.importErrors.other", { reason: raw || "?" });
}

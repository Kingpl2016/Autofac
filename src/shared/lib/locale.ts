/** 界面语言与 `Intl` / `lang` 属性用的语言标签之间的换算。 */

/**
 * 界面语言（`zh` / `en`，也接受 `zh-CN` 这类完整标签）对应的 BCP 47 标签。
 *
 * @param language 界面语言。
 * @returns 中文为 `zh-CN`，其余为 `en`。
 */
export function intlLocale(language: string): "zh-CN" | "en" {
  return language.startsWith("zh") ? "zh-CN" : "en";
}

import { useTranslation } from "react-i18next";

/** 带名称的预设。 */
interface Labelled {
  /** 展示名称。 */
  label: string;
  /** 可选的 i18n key。 */
  labelKey?: string;
}

/**
 * 获取预设名称的展示函数：优先使用 i18n，翻译缺失（如第三方插件未提供）时回退到 `label`。
 *
 * @returns 传入预设，返回当前语言下的名称。
 */
export function usePresetLabel(): (preset: Labelled) => string {
  const { t, i18n } = useTranslation();
  return (preset) => {
    // labelKey 来自插件，类型上无法保证存在于语言包，因此运行期检查后再翻译
    if (preset.labelKey && i18n.exists(preset.labelKey)) return t(preset.labelKey);
    return preset.label;
  };
}

/**
 * 获取分组标题的展示函数：优先使用语言包里的 `appearance.presets.groups.<key>`，缺失时直接显示 key。
 *
 * @returns 传入分组 key，返回当前语言下的标题。
 */
export function useGroupTitle(): (key: string) => string {
  const { t, i18n } = useTranslation();
  return (key) => {
    const full = `appearance.presets.groups.${key}`;
    return i18n.exists(full) ? t(full) : key;
  };
}
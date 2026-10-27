/** token 名到取值的映射，名称形如 `--background`，值为 CSS 值。 */
export type TokenMap = Readonly<Record<string, string>>;

/** 一个主题在明、暗两种模式下的 token。 */
export interface ThemeTokenSet {
  /** 亮色模式的 token。 */
  light: TokenMap;
  /** 暗色模式的 token。 */
  dark: TokenMap;
}

/** 预设的展示信息。 */
export interface PresetMeta {
  /** 唯一 id；重复注册时后注册的覆盖先注册的。 */
  id: string;
  /** 展示名称（当没有 labelKey 或翻译缺失时使用）。 */
  label: string;
  /** 可选的 i18n key，提供时优先于 label 展示。 */
  labelKey?: string;
  /** 排序，数值越小越靠前，缺省为 100；相同则按注册先后。 */
  order?: number;
  /** 分组 key，面板按它分组展示；对应语言包 `appearance.presets.groups.<key>`，缺失的分组直接显示 key。 */
  group?: string;
}

/** 整套主题预设：页面、卡片、边框等表面色 token。主色另由主色预设控制。 */
export interface ThemePreset extends PresetMeta {
  /** 明暗两套 token，只允许白名单内的 token。 */
  tokens: ThemeTokenSet;
}

/** 主色预设：只给出一个颜色，应用的强调色色相与彩度由它折算。 */
export interface AccentPreset extends PresetMeta {
  /** 十六进制主色，如 `#6366f1`。 */
  color: string;
}

/** 字体预设。 */
export interface FontPreset extends PresetMeta {
  /** 无衬线（界面）字体栈。 */
  sans: string;
  /** 等宽字体栈；缺省时沿用默认等宽字体。 */
  mono?: string;
  /** 可选的加载函数，如动态引入 web 字体；应用该字体前会调用，失败不影响应用字体栈。 */
  load?: () => Promise<void>;
}

import { defineFeaturePlugin } from "@/shared/plugin";

/**
 * AI 模型接入：厂商配置、API Key（后端系统凭据管理器）、经后端代理的模型调用。
 *
 * 不贡献页面：设置界面由设置页的“AI 助手”分区渲染（`AiSettingsPanel`），
 * 调用方（节目编辑器）经 `loadLanguageModel` 按需加载 AI SDK。
 */
export const aiPlugin = defineFeaturePlugin({ name: "ai" });

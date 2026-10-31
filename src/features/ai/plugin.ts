import { defineFeaturePlugin } from "@/shared/plugin";
import { AiModelsDialogHost } from "./components/AiModelsDialogHost";

/**
 * AI 模型接入：厂商配置、API Key（后端系统凭据管理器）、经后端代理的模型调用。
 *
 * 不贡献页面：设置界面由设置页的“AI 助手”分区渲染（`AiSettingsPanel`），
 * 调用方（节目编辑器）经 `loadLanguageModel` 按需加载 AI SDK。
 * “模型配置”对话框挂在全局覆盖层，调用方用 `openAiModelsDialog()` 打开，不用跳到设置页。
 */
export const aiPlugin = defineFeaturePlugin({
  name: "ai",
  setup: ({ slots }) => slots.register("layout.overlays", { id: "ai-models-dialog", order: 60, component: AiModelsDialogHost }),
});

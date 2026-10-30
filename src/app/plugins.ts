/**
 * 应用插件清单。
 *
 * - 顺序即默认执行顺序（有 `dependsOn` 的插件会被排到依赖之后）。
 * - 增加能力：实现 `AppPlugin` 并加入列表。
 * - 关闭能力：给插件加 `enabled`。
 * - 移除能力：删除对应 feature 目录并去掉这里的一行。
 */
import { aboutPlugin } from "@/features/about";
import { aiPlugin } from "@/features/ai";
import { appearancePlugin } from "@/features/appearance";
import { appModePlugin } from "@/features/app-mode";
import { dashboardPlugin } from "@/features/dashboard";
import { discoveryPlugin } from "@/features/discovery";
import { enginePlugin } from "@/features/engine";
import { fixturesPlugin } from "@/features/fixtures";
import { forwardingPlugin } from "@/features/forwarding";
import { i18nPlugin } from "@/features/i18n";
import { libraryPlugin } from "@/features/library";
import { networkPlugin } from "@/features/network";
import { recordingPlugin } from "@/features/recording";
import { settingsPlugin } from "@/features/settings";
import { showEditorPlugin } from "@/features/show-editor";
import { signalCheckerPlugin } from "@/features/signal-checker";
import { signalFlowPlugin } from "@/features/signal-flow";
import { universesPlugin } from "@/features/universes";
import type { AppPlugin } from "@/shared/plugin";
import { shellPlugin } from "./shellPlugin";

/** 主应用启用的插件。 */
export const appPlugins: readonly AppPlugin[] = [
  shellPlugin,
  enginePlugin,
  appModePlugin,
  recordingPlugin,
  signalCheckerPlugin,
  // 语言先于外观：个性化面板里的文案依赖已就绪的语言
  i18nPlugin,
  appearancePlugin,
  dashboardPlugin,
  universesPlugin,
  discoveryPlugin,
  forwardingPlugin,
  signalFlowPlugin,
  libraryPlugin,
  aiPlugin,
  showEditorPlugin,
  fixturesPlugin,
  networkPlugin,
  settingsPlugin,
  aboutPlugin,
];

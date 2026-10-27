---
inclusion: fileMatch
fileMatchPattern: "src/**/*.{ts,tsx}"
---
# 前端插件化架构（`src/`）

前端是一个微内核：内核只负责“装配”，每个能力是一个插件，通过 `PluginContext` 把自己的页面、导航、顶栏按钮、监听器挂到宿主上。宿主（布局、侧栏、顶栏）不 import 任何具体功能。

## 目录

```
src/shared/plugin/    内核：AppPlugin 契约、setupPlugins、Slot / 路由 / 导航 / 外观注册表（无业务含义）
src/shared/events/    RxJS：类型化 EventBus、fromTauriEvent、useObservable / useSubscription
src/shared/appearance/ 外观的纯逻辑：token 白名单、OKLCH、预设注册表（插件和面板共用）
src/app/              bootstrap（启动）、App（Provider + 路由）、plugins.ts（插件清单）、shellPlugin（导航分组）
src/features/<x>/plugin.ts   每个 feature 一个插件入口，经 index.ts 导出
```

## 写一个插件

- 页面型 feature 用 `defineFeaturePlugin({ name, routes, nav, Runtime?, setup? })`：路由用 `load: namedExport(() => import("./components/XView"), "XView")` 按需加载，导航项的 `section` 引用 `shellPlugin` 声明的分组 id（signal / program / network / system）。
- 需要在组件树里跑的钩子（`useXxxListeners`）放进 `Runtime` 组件，不要再往 `App` 里加调用。
- 顶栏按钮用 `slots.register("header.actions", { id, order, component })`；顶栏左侧状态用 `header.status`；全局对话框用 `layout.overlays`；个性化面板的额外分区用 `appearance.sections`。同 id 后注册的覆盖先注册的，`order` 小的靠前。
- `setup` 可以返回清理函数；多个注册的清理合并返回即可。依赖别的插件时写 `dependsOn`，运行时会排序并在缺依赖时报错。
- 在 `src/app/plugins.ts` 加一行启用；删除 feature 目录并去掉这一行即移除，宿主不受影响。
- **index.ts 只导出插件和外部真正需要的符号，不要导出页面视图**：页面视图只允许经插件的动态 `import()` 到达，否则会被打进首屏包（`vite build` 能看到分包是否生效）。

## 事件与数据

- 跨插件通信用 `EventBus`（新增事件通过 `declare module "@/shared/events/eventBus"` 扩充 `AppEventMap`），不要互相 import 内部文件。
- Tauri 事件用 `fromTauriEvent<T>(name)` 得到冷 Observable，组件里用 `useSubscription` 订阅；不要手写 `listen` + 取消订阅。
- 高频数据（引擎帧）继续用 zustand store，不要套 RxJS。
- `shared` 不依赖 `features`：需要“业务把自己接入共享流程”时用登记表（例如 `registerDmxFrameHandler`），由业务插件在 `setup` 里登记。

## 个性化（外观插件）

- 设置模型在 `features/appearance/lib/appearanceSettings.ts`（zod，逐字段兜底）；折算成 CSS 变量的是 `computeVars`，折算成 `data-*` 属性的是 `computeAttrs`（默认值不写属性，样式表只针对非默认值，见 `src/styles/appearance.css`）。
- 新增一项设置：模型 + 默认值 + `pickSettings` + schema → `computeVars` / `computeAttrs`（并把键加入 `MANAGED_ATTR_KEYS`）→ 样式表规则 → 面板里的控件 → 中英文语言包。
- 主色只改 `--accent-h` / `--accent-c`，`--primary`、`--ring`、热力色阶都由 CSS 派生；状态语义色（成功 / 告警 / 录制 / 在线）不在 token 白名单内，任何主题和主色都改不了。
- 组件里需要“实际生效的明暗”用 `useResolvedMode()`（会随系统变化），不要直接读 store 的 `mode`；canvas 里读 CSS 变量的组件把 `useAppearanceRevision()` 放进重绘依赖。
- 首屏防闪烁：外观每次变化同步写 `localStorage` 快照，`index.html` / `signal-checker.html` 的内联脚本在首次绘制前还原（键由 `APPEARANCE_SNAPSHOT_KEY` 定义，有测试保证两边一致）。

## 焦点环

样式统一用 `focus-visible:`，禁止 `focus:ring` / `focus:outline`（鼠标点击后会亮边）；有守卫测试 `components/ui/__tests__/focusGuard.test.ts`。

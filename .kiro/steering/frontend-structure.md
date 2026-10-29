---
inclusion: auto
name: frontend-structure
description: 当生成、修改或审查 src/ 目录下的前端代码（TypeScript、React、CSS）时使用。
---

# 前端代码结构规范

适用于 `src/`。插件化架构（插件契约、插槽、事件总线、个性化）见 `plugin-architecture.md`，本文只讲目录归位与公共模块。
本规范描述**当前代码的真实结构**；发现与现状不符时先改规范再改代码。

## 1. 目录分层

```
src/
├── app/            启动（bootstrap）、根组件、路由、插件清单（plugins.ts）、外壳插件
├── bindings/       由 Rust DTO 生成的类型（ts-rs，`npm run gen:types`）；不要手改（见第 6 节）
├── components/ui/  shadcn 风格原语（基于 radix-ui）；不写业务
├── lib/utils.ts    cn()
├── layouts/        主布局、侧栏、顶栏、底部状态条
├── features/<x>/   业务功能，一个插件一个目录
│   ├── components/ hooks/ lib/ stores/ __tests__/
│   ├── plugin.ts   插件入口
│   └── index.ts    唯一公开出口（只导出插件与外部真正需要的符号）
├── shared/         不需要懂业务就能看明白的代码（见第 3 节）
├── signal-checker/ 信号检测器窗口的入口（main.tsx）
├── styles/         全局样式
└── test/           测试工具（见第 4 节）
```

信号检测器是第二个 HTML 入口：它经 `@/features/signal-checker/window` 拿根组件，主窗口经 index 只拿插件，
这样主窗口首屏不会带上检测器视图。

## 2. 分层规则（ESLint 强制）

- `shared` / `layouts` / `lib` **不能**导入 `@/features/**`。业务需要接入共享流程时用登记表或插槽。
- 功能之间只能经对方的 index：`@/features/<x>`；禁止 `@/features/<x>/lib/...` 这类深层导入（测试除外）。
  需要的符号在对方 index 导出；多个功能都要的、与业务无关的，下沉到 `shared`。
- 跨层一律用 `@/` 别名，禁止 `../../../shared/...` 这样用相对路径爬出所在功能。功能内部用相对路径。
- Tauri 事件只能经 `@/shared/events` 订阅，`@tauri-apps/api/event` 与 `@/shared/tauri/events` 只允许在
  `shared/events`、`shared/tauri` 里导入。
- 不保留“为兼容旧路径”的再导出文件：符号挪走后，调用方直接改导入。

## 3. 公共模块：先找再写

写新的工具函数 / hook 之前先在这里找，不要在功能里再复制一份。

| 需要 | 用 |
|---|---|
| 夹取 | `shared/lib/math`：`clamp`、`clamp01` |
| 数值 / 字节 / 时长 | `shared/lib/format`：`formatCount`、`formatBytes`（KB/MB）、`formatBytesIec`（KiB/MiB，节目文件大小）、`formatHms`（`m:ss` / `h:mm:ss`，各处时间码在它后面接自己的小数部分）、`pad2`、`formatDuration`、`formatPacketRate`。磁盘空间用 `shared/domain/disk` 的十进制格式 |
| 相对时间 | `shared/lib/relativeTime`：`formatRelativeTime(at, now, locale, { minUnit, maxUnit, nowUnit, dateAfterMs, rounding })` |
| 界面语言 → `Intl` 语言标签 | `shared/lib/locale`：`intlLocale` |
| 异常 → 文本 | `shared/lib/errors`：`errorMessage`。各功能只保留自己的“错误码 → 文案”映射 |
| 改动后端状态的命令（提交中、toast、刷新查询） | `shared/hooks/useCommand`：`useCommand({ run, success, describe, invalidate, invalidateOn, onSuccess })` → `{ run, pending, variables }`，基于 TanStack Query `useMutation`；`run` 失败已提示、不抛出，返回是否成功。网络设备页用 `useNetCommand`（错误经 `errorText` 翻译）。不要再手写 `busy` 状态 + `invalidateQueries` |
| 命令面板 / 可搜索列表 | `cmdk`（节目编辑器的 `CommandPalette`）：排序沿用自己的 `rankCommands`，所以 `shouldFilter={false}`；它只在按需加载的编辑器包里 |
| 剪贴板 | `shared/lib/clipboard`：`copyText(text, { success, failure })` |
| 屏幕取色 | `shared/lib/eyeDropper`：`canPickScreenColor`、`pickScreenColor` |
| 颜色换算 | `shared/appearance/hsv`、`oklch`（各通道 0~1）；编辑器的 `[r,g,b]` 0~255 版本是它们的适配层 |
| 快捷键 | `shared/lib/keyboard`：`isTextEntry`（文本输入控件）、`isInteractiveTarget`（自己处理空格 / 方向键的控件）、`chordOf` / `parseChord` / `formatChord` |
| 窗口级 keydown | `shared/hooks/useWindowKeydown`：`useWindowKeydown(handler, { enabled, capture })`、`useSlashToFocus(ref)`。不要手写 `addEventListener("keydown")` + 清理 |
| 防抖 | `shared/hooks/useDebounced`：`useDebouncedValue`、`useDebouncedCallback(fn, ms)` → `{ schedule, flush, cancel, pending }` |
| 元素尺寸 | `shared/hooks/useElementSize(ref, { key, onResize })`。不要手写 `ResizeObserver` |
| Canvas | `shared/lib/canvas`：`prepareCanvas`（按 DPR 设尺寸并清空）、`themeColor`（读 CSS 变量） |
| 可拖动分隔条 | `shared/components/ResizeSeparator`（`role="separator"`、拖动、方向键、Home/End、双击恢复） |
| 媒体查询断点 | `shared/lib/breakpoints`：`MEDIA_LG` / `MEDIA_XL` / `MEDIA_2XL` / `MEDIA_REDUCED_MOTION` |
| Tauri 事件 | 组件里 `useTauriEvent(name, handler)`；组件外 `tauriEvent$(name)`（引用稳定的冷 Observable）。没有 Tauri 运行时时订阅失败被静默忽略 |
| 持久化界面偏好 | `shared/stores/persistPrefs`：`persistPrefs({ name, version, schema })`，schema 是每个字段带 `.catch(默认值)` 的 `z.object`；`prefsSanitizer(schema)` 得到清洗函数。`name` / `version` 是已有用户数据的键，不能改 |
| 分段选择 | `shared/components/Segmented`（单选，`radiogroup`）；只改筛选的按钮组用 `SegmentedControl`（`aria-pressed`） |

## 4. 测试

- 测试放在被测代码同级的 `__tests__/`，命名 `<原名>.test.ts(x)`；需要 DOM 的文件第一行写 `// @vitest-environment jsdom`。
- 组件测试用 `@/test/renderWithProviders`：`renderWithProviders(ui, { route?, client? })`，自带关闭重试的查询客户端，
  传 `route` 时包一层内存路由，返回值带 `client`（可 `vi.spyOn(client, "invalidateQueries")`）。
- Tauri 事件用共享的内存总线：

  ```ts
  vi.mock("@/shared/tauri/events", async () => (await import("@/test/mockTauriEvents")).tauriEventsModule);
  import { tauriEvents } from "@/test/mockTauriEvents";
  beforeEach(() => tauriEvents.reset());
  act(() => tauriEvents.emit("player:state", status));
  ```

  模拟没有 Tauri 运行时（订阅失败）用 `tauriEvents.failWith(error)`，`reset()` 恢复。
- 后端 DTO 的测试数据用 `@/test/factories`（如 `makeDevice({ ip })`）：生成的类型字段全部必填，
  工厂给齐默认值，后端加字段时只改工厂。
- jsdom 没有 `ResizeObserver`：用 `stubResizeObserver()`（`@/test/mockTauriEvents`）；
  没有 `scrollIntoView`（cmdk 会调用）：打开命令面板的测试里 `Element.prototype.scrollIntoView = vi.fn()`。
- Vitest 只收集 `src/**`（`vite.config.ts` 的 `test.include`），单个用例超时 15 秒。

## 5. 依赖与提交前检查

- 依赖版本写精确版本（不用 `^` / `~`）；构建期工具放 `devDependencies`。
- 重依赖（React Flow、tsParticles、着色器、driver.js、idb-keyval、dnd-kit 等）只能出现在按需加载的路径（路由页或 `lazy()` / 动态 `import()`）。
- 提交前运行 `npm run verify`：`tsc -b && eslint . && vitest run && knip`。
  knip 检查未使用的文件、依赖与导出（未使用的导出也算错误）；配置在 `knip.json`，忽略 `src/components/ui/**` 与 `src/bindings/**`。

## 6. 与后端对应的类型（ts-rs）

- 后端 DTO 不在前端手写：Rust 类型加 `#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]`，
  运行 `npm run gen:types` 生成到 `src/bindings/<类型名>.ts`（先清空目录再生成），连同 Rust 改动一起提交。
  `npm run check:types` 重新生成并检查与已提交版本一致。
- 各 crate 的 `ts-rs` 是可选依赖，挂在自己的 `ts` feature 上（依赖的 crate 用 `"<dep>/ts"` 级联），发布构建不包含。
  输出目录与 `u64 → number` 映射在 `src-tauri/.cargo/config.toml` 的 `[env]`。
- 序列化与类型要对得上：
  - `Option` + `skip_serializing_if` → `ts(optional)`（`k?: T`）；非 `Option` 的跳过字段 → `ts(as = "Option<_>", optional)`；
  - 输入里可省略的 `Option`（`serde(default)`）→ `ts(optional = nullable)`，或整结构 `ts(optional_fields)`；
  - `serde(with = ...)` 改了线上形态的字段（如 Base64 行）→ `ts(type = "Array<string>")`；字面量取值 → `ts(type = "1 | 2")`。
- 前端经各功能的 `lib/types.ts`（或 `shared/domain/*`）转出，需要时起前端习惯的别名，例如
  `export type { DeviceView as NetDevice } from "@/bindings/DeviceView"`。界面用的顺序常量写成
  `[...] as const satisfies readonly PatternId[]`，取值不在后端枚举里时编译报错。
- 只在前端存在的结构（解码后的时间线、事件载荷的组合形态、刻意收窄的联合类型如 `PlayerTarget`）继续手写，并注明原因。

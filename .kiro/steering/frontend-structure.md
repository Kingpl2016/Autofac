---
inclusion: auto
name: frontend-structure
description: 当生成、修改或审查 web/ 目录下的前端代码（TypeScript、React、CSS）时使用。
---

# 前端代码结构规范

适用于 `web/src/`。本规范描述的是**当前代码的真实结构**；新增代码按此归位，发现与现状不符时先改规范再改代码。

---

## 1. 目录分层

```
web/src/
├── app/            ← 路由表（router.tsx）、根组件（AppRoot）、全局 Provider
├── components/ui/  ← shadcn 原语（radix-nova）；由 shadcn CLI 生成，不手写业务
├── lib/utils.ts    ← shadcn 约定的 cn() 出口；业务代码一律从 @/lib/utils 导入 cn
├── hooks/          ← shadcn 约定位置（use-mobile.ts），业务 hook 不放这里
├── features/       ← 业务代码的唯一归宿
│   └── <domain>/<slice>/
│       ├── components/  该切片的 React 组件
│       ├── hooks/       该切片的 hook（useXxx.ts）
│       ├── lib/         纯逻辑函数、类型、常量
│       ├── __tests__/   测试
│       └── index.ts     公开 API（唯一出口）
├── layouts/        ← 页面布局（主布局、顶栏、侧栏、守卫）
├── pages/          ← 路由页面，每个路由一个薄层文件，只做组合
├── shared/         ← 跨功能通用代码（无业务含义）
│   ├── components/ 通用 UI（MutationDialog / ServerError / SearchInput / TablePagination / DataTableView …）
│   ├── hooks/      通用 hook（useApiMutation / useDateRangePresets / useDirtyCloseGuard …）
│   │   └── queries/ 跨功能共享的数据查询（useDevices / useBranches …，只封装 endpoint + queryKey）
│   ├── lib/        通用纯函数（datetime / pagination / urlState / dateRangePresets …）
│   ├── domain/     跨功能共用的核心类型与派生（types / deviceState）
│   ├── i18n/       国际化（中文内置，英文按需加载）与语言包
│   ├── navigation/ 导航配置
│   ├── request/    HTTP 客户端、错误类型、endpoints/<resource>.ts
│   ├── stores/     全局状态（authStore / prefsStore，zustand）
│   ├── theme/      外观引擎
│   ├── queryClient.ts  全局 QueryClient 与 LIVE_QUERY_OPTIONS
│   └── queryKeys.ts    查询键工厂
└── test/           ← 测试基础设施（setup / renderWithProviders / renderUrlHook / factories / viewport）
```

现有领域：`devices`（device-list / device-detail / device-actions / device-delete / device-trash / register-device / status）、
`organization`（branches / users / geo）、`device-records`、`operation-logs`、`stats`（analysis / charts / export）、
`dashboard`、`auth`、`search`、`settings`、`appearance`。

---

## 2. 分层规则

- **features/**：只有这个功能用的代码。`index.ts` 只导出外部消费者需要的符号；**禁止 `export * from`**。
  同一领域下多个切片共用的逻辑可放 `features/<domain>/lib`，跨切片一律用 `@/features/<domain>/...` 导入，不得反向依赖某个切片的内部文件。
- **pages/**：薄层，只组合 `features/` 的组件；不写 hook、不写业务函数；一个路由目录不应超过 2 个文件。
- **shared/**：不需要了解任何业务概念就能理解的代码。需要懂业务才能看明白的，属于 `features/`。
- 无法判断归属时，默认放 `features/`。

### 新增代码决策树

```
多个功能共用的 UI（无业务含义）        → shared/components/
多个功能共用的 hook                    → shared/hooks/（数据查询放 shared/hooks/queries/）
多个功能共用的纯函数                    → shared/lib/
HTTP 请求函数                          → shared/request/endpoints/<resource>.ts
查询键                                 → shared/queryKeys.ts（组件里不要手写字面量数组）
全局应用状态                            → shared/stores/
某个业务功能专属的组件 / hook / 纯逻辑   → features/<domain>/<slice>/{components,hooks,lib}/
路由入口页面                            → pages/<route>/<RoutePage>.tsx
```

---

## 3. 测试

- 测试放在被测代码**同级**的 `__tests__/` 目录，命名 `<原名>.test.ts(x)`；不得与源码并排。
- 组件测试统一用 `@/test/renderWithProviders`（i18n + QueryClient(retry:false) + 路由 + nuqs 测试适配器；`route` 里的查询串会成为初始 URL 参数）。
- 读写 URL 参数的 hook 用 `@/test/renderUrlHook`；URL 更新经 nuqs 队列异步写出，断言要 `await expectQuery(...)`。
- `src/test/setup.ts` 预置英文文案，测试里 `i18n.getFixedT("en")` 可直接使用。
- 守卫类测试：`src/test/__tests__/styleGuards.test.ts`（颜色 / 渐变 / 调色板类 / 写死像素字号）、
  `noHardcodedText.test.ts`（界面文案必须走 i18n）、`shared/i18n/__tests__/locales.test.ts`（中英文键一致、代码里的字面量键已定义）。

---

## 4. import 路径与命名

| 场景 | 方式 |
|------|------|
| 跨层级（features → shared，pages → features） | `@/` 别名（`@/` = `src/`） |
| 同切片内部（components → hooks / lib） | 相对路径 |

| 类型 | 规范 |
|------|------|
| React 组件 | `PascalCase.tsx` |
| hook | `useCamelCase.ts` |
| 纯函数 / 工具 | `camelCase.ts` |
| 桶文件 | `index.ts` |

---

## 5. 请求与数据

1. **features / pages / layouts（非测试代码）禁止直接 `import axios` 或 `@/shared/request/client`**，必须经 `shared/request/endpoints/*`（ESLint `no-restricted-imports` 强制）。
   新增 API 前先看 `endpoints/` 下是否已有对应资源文件。
2. **查询键**一律经 `shared/queryKeys.ts` 工厂；列表类 key 的过滤 / 分页参数以对象传入。
3. **数据新鲜度**（没有实时推送，靠拉取）：全局开启 `refetchOnWindowFocus`；需要保持较新的查询（设备列表、总览指标、排行）
   展开 `LIVE_QUERY_OPTIONS`（30 秒静默轮询，标签页在后台时暂停）。不要各自手写 `refetchInterval`（操作日志的用户可选自动刷新除外）。
4. **mutation** 一律用 `useApiMutation`（成功后：自定义处理 → 失效查询 → 成功提示），不要在组件里重复写 `useMutation + invalidate + toast`。
5. **错误展示**：服务端错误用 `<ServerError error={mutation.error} />`；取文案用 `getErrorMessage` / `isApiStatus`（`shared/request/errors.ts`），
   不要手写 `error instanceof ApiError ? ... : t("common.unknownError")`。

---

## 6. 弹窗与表单

1. 「取消 + 提交」型弹窗一律用 `shared/components/MutationDialog`：统一提交中不可关闭、按钮加载态、服务端错误条。
   - 带表单的传 `formId`（提交按钮绑定到弹窗内 `<form id>`）；
   - 编辑类弹窗传 `guard={useDirtyCloseGuard(dirty, onClose)}`，自动获得「放弃更改？」确认并拦截点遮罩关闭与浏览器刷新 / 关闭。
2. 弹窗**每次打开都是全新实例**：外层 `if (!open) return null`，表单本体在内部，不要用 effect 重置状态。
3. 表单统一 react-hook-form + zod + `zodResolver`；字段外壳用 `components/ui/field`。
   同名冲突（409）标在字段上（`onError` 里 `setError`），并让底部错误条跳过该错误。
4. 多步 / 逐项处理的批量弹窗（删除 / 清除 / 批量追加）有自己的阶段状态，不套 `MutationDialog`。

---

## 7. URL 状态（nuqs）

1. 筛选、排序、分页、视图、标签页等可分享状态存在 URL 查询参数里，统一用 **nuqs**：`useQueryStates(parsers, { history: "replace" })`。
2. 解析器放在各切片的 `lib/*Filters.ts`，公共解析器在 `shared/lib/urlState.ts`
   （`pageParser` / `pageSizeParser` / `dateParser` / `textParser` / `literalParser`）：
   非法取值回退默认值，与默认值相同的参数不写进地址栏。字段名与参数名不同时用 `urlKeys`。
3. 筛选变化时同一次更新里 `page: null` 回到第 1 页。`PAGE_SIZES` / `DEFAULT_PAGE_SIZE` 只在 `shared/lib/pagination.ts` 定义。
4. 应用根部（`app/router.tsx` 的 `UrlStateRoot`）挂 `NuqsAdapter`，并设 `defaultOptions.shallow = false`，
   让参数更新同时走路由导航，`useLocation` 与登录跳转记录的来源地址始终是最新的。
   不要在同一批参数上混用 `useSearchParams` 和 nuqs 写入。
5. 日期范围的快捷选项用 `useDateRangePresets(today)`，计算在 `shared/lib/dateRangePresets.ts`。

---

## 8. 国际化与样式

1. 所有界面文案走 i18n（`t("a.b")`）；中英文键必须一致。中文随首屏内置，英文在首次切换时才加载（`shared/i18n/index.ts`），
   首屏渲染前等待 `i18nReady`。
2. 技术栈：组件来自 shadcn/ui（`components/ui` 与 `shared/components`），图标 lucide-react，图表 Recharts（经 `ThemedLine`），
   表格 TanStack Table（经 `DataTableView`），提示用 sonner 的 `toast`，状态用 zustand。
3. 颜色只走语义 token（`bg-primary/10`、`text-destructive` …）；禁止渐变、写死的十六进制 / rgb 颜色、Tailwind 调色板类和写死像素字号；
   间距优先用 `gap-(--density-gap)`、`p-(--density-gutter)` 等密度令牌。
4. 重库（`recharts` 等）只能出现在按需路径（路由页或 `lazy()` 组件），不得进首屏同步依赖。

---

## 9. 依赖与提交前检查

- 依赖版本固定为精确版本（新增依赖不要用 `^` / `~`）；构建期工具（`tailwindcss`、`@tailwindcss/vite`、`tw-animate-css`、`shadcn`）放 `devDependencies`。
- 提交前运行 `npm run verify`（`tsc -b && eslint . && vitest run && knip`）。`knip.json` 忽略 `src/components/ui/**`（shadcn 生成物）。
- `cn` 来自 npm 包 `cn@0.5.0`（clsx + tailwind-merge 的合并实现）；`components/ui/*` 保持 shadcn 生成的 `from "cn"`，业务代码从 `@/lib/utils` 导入。

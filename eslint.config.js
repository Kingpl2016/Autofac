import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

/** 测试文件：可以引用被测功能的内部文件，不受分层规则约束。 */
const TEST_FILES = ["src/**/__tests__/**", "src/test/**"];

/** 用相对路径越出所在目录、进入其它层（应改用 `@/` 别名）。 */
const RELATIVE_CROSS_LAYER = {
  regex: String.raw`^(\.\./)+(shared|layouts|app|test|components/ui)/|^(\.\./)+lib/utils$`,
  message: "跨层导入请用 `@/` 别名（例如 `@/shared/...`），不要用相对路径爬出所在功能。",
};

/** Tauri 事件只经 `@/shared/events`（`useTauriEvent` / `tauriEvent$`）订阅，不手写 listen + unlisten。 */
const RAW_TAURI_EVENTS = {
  group: ["@tauri-apps/api/event", "@/shared/tauri/events"],
  message: "订阅 Tauri 事件请用 `useTauriEvent`（组件里）或 `tauriEvent$`（`@/shared/events`），不要手写 listen / onEvent。",
};

/** 跨功能只能经对方的公开入口 `@/features/<x>`（检测器窗口另有 `window` 入口）。 */
const FEATURE_DEEP_IMPORT = {
  group: ["@/features/*/**", "!@/features/signal-checker/window"],
  message: "跨功能只能从对方的 index 导入（`@/features/<x>`）；需要的符号请在对方 index.ts 里导出，或下沉到 shared。",
};

export default tseslint.config(
  // src/bindings 是 ts-rs 从 Rust DTO 生成的类型（npm run gen:types），不手改
  { ignores: ["dist", "src-tauri", ".kiro", "src/components/ui/**", "src/bindings/**"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      // 以 `_` 前缀标记有意未使用的参数 / 变量（如 mock 的占位签名）
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // 分层：功能之间只经公开入口互相引用
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: TEST_FILES,
    rules: {
      "no-restricted-imports": ["error", { patterns: [FEATURE_DEEP_IMPORT, RELATIVE_CROSS_LAYER, RAW_TAURI_EVENTS] }],
    },
  },
  // 分层：内核与宿主（shared / layouts / lib）不依赖任何具体功能
  {
    files: ["src/shared/**/*.{ts,tsx}", "src/layouts/**/*.{ts,tsx}", "src/lib/**/*.{ts,tsx}"],
    ignores: TEST_FILES,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            RELATIVE_CROSS_LAYER,
            RAW_TAURI_EVENTS,
            {
              group: ["@/features", "@/features/**"],
              message: "shared / layouts / lib 不能依赖具体功能；需要业务接入时用登记表或插槽（见 plugin-architecture.md）。",
            },
          ],
        },
      ],
    },
  },
  // 事件封装本身：允许直接用 Tauri 的 listen（放在最后，覆盖上面 shared 的规则）
  {
    files: ["src/shared/events/**/*.{ts,tsx}", "src/shared/tauri/**/*.{ts,tsx}"],
    ignores: TEST_FILES,
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [RELATIVE_CROSS_LAYER, { group: ["@/features", "@/features/**"], message: "shared 不能依赖具体功能。" }] },
      ],
    },
  },
);

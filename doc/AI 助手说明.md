# 节目编辑器 AI 助手说明

节目编辑器可以用自然语言生成和修改灯光：一键 AI 草稿、多轮对话修改、改动先审阅再写入。
本文说明整体结构、减小不同模型之间差异的做法、中间语言（AiOps）的规范，以及如何扩展和评测。

## 1. 使用

1. **设置 → AI 助手**：添加配置（服务预设、接口地址、模型、API Key、温度、种子），点“测试”确认能连上。星标的是默认配置。
   模型一栏是可搜索的下拉框：打开时经后端向接口的 `/models` 拉取模型列表，并列出预设里的常用模型；拉取失败时显示原因，仍可选预设或直接输入任意模型名。
2. **一键草稿**（工具条的魔杖按钮）：选“AI 生成”，写一句描述，可选调色板。模型按段落编排；工程没有段落时按 8 小节（没有节拍时按 15 秒）切分，并随草稿一起建出段落。
3. **AI 助手面板**（编辑器右侧，工具条的机器人按钮或 `Ctrl+J` 打开 / 收起，宽度可拖动）：多轮对话。可以引用选中的片段（“把选中的片段改成蓝紫色”），也可以只提问。
   - 输入框左下角切换本次对话用的模型配置；
   - 回复支持 Markdown；工具调用显示为可展开的步骤；
   - 每条消息可复制，用户消息可编辑后重发，AI 回复可重新生成；多个版本用 ‹ › 切换，全部随对话记录保存，重开工程后停在上次看的版本；
   - 模型提交的改动在对话里显示为提议卡片，可以直接应用或放弃；结局（已应用 / 已放弃）也随对话记录保存；
   - 用到记忆的回复下方显示“参考了 N 条记忆”，展开后可以直接停用或删除某一条。
4. **审阅**：AI 的改动先进入暂存区。编辑器顶部出现“AI 改动待审阅”条，预览区显示改动后的效果（可以切回当前工程对比），面板顶部有逐项清单（点片段跳到它的起点）。点“应用”写入工程，算一步撤销。
5. **自动写入**（输入框右下角、发送按钮左边的闪电按钮；设置 → AI 助手里是同一个开关）：打开后按钮高亮并显示“自动”，改动直接写入并提示“撤销”。改灯具配接、输出设置或一次删除超过 20 个片段的改动，仍然先让你确认。
6. **记忆**（见第 7 节）：
   - 在对话里说“记住……”“以后都……”，AI 会给出一张记忆卡片，点“保存”才写入；
   - 面板标题栏的脑形按钮打开记忆页：本工程笔记、本工程范例、所有工程共用的范例；
   - 个人偏好在设置 → AI 助手里管理。

新手引导：第一次进入编辑器的导览里有一步指向工具条的 AI 按钮；另有四条局部提示（`onboarding/guideContent.ts`，按顺序出现）：AI 入口、输入框（怎么说、模型、自动写入、重新生成）、待审阅的改动、记忆按钮。看过旧版导览的用户不会重播导览，由这几条提示补上；帮助菜单（F1）的“显示本页提示”可以一次全部显示。

## 2. 结构

```
src/features/ai/                      AI 插件（与业务无关）
  lib/proxyFetch.ts                   交给 AI SDK 的 fetch：请求经后端代理发出
  lib/model.ts                        按配置创建模型（OpenAI 兼容 / Anthropic / Gemini），只经动态 import 加载
  lib/loadModel.ts                    loadLanguageModel / testConnection
  components/AiSettingsPanel.tsx      设置页“AI 助手”分区的内容
  components/ModelCombobox.tsx        可搜索的模型下拉框（ai_list_models 拉取列表）
  components/MemoryNoteList.tsx       可编辑的记忆列表（个人偏好、工程笔记共用）
  lib/memory.ts / lib/memoryFile.ts   记忆条目的纯函数；数据目录里记忆文件的读写
  stores/useAiMemoryStore.ts          个人偏好记忆
src/features/show-editor/components/ai/
  AiDockLayout.tsx / AiDock.tsx       编辑器右侧的停靠面板（按需加载）
  AiChatPanel.tsx                     对话：AI SDK useChat + DirectChatTransport → assistant-ui 运行时（灌入消息树、挂记忆元数据）
  AiMemoryPage.tsx                    记忆页
  thread/                             基于 assistant-ui 原语的对话界面（消息、操作栏、工具步骤、提议卡片、记忆卡片、记忆来源、模型切换、自动写入开关）
src/features/show-editor/ai/          编辑器专属
  vocab.ts                            受控词汇：命名色、调色板、周期 / 大小 / 速度 / 淡入淡出档位与量化
  timeRef.ts                          时间引用（小节、段落、秒）的解析与量化
  aliases.ts                          短别名 F1 / G1 / T1 / C1 / S1 / M1
  opsSchema.ts                        AiOps 与草稿计划的 zod 结构
  portableSchema.ts                   zod → 各家都接受的 JSON Schema 子集
  compile.ts                          AiOps 编译器：复用编辑器的纯函数写入工程，试运行与语义校验
  context.ts                          发给模型的工程摘要与只读查询
  prompt.ts                           系统提示词（带 PROMPT_VERSION）
  recipes.ts                          配方：整段灯光的宏操作（applyRecipe），确定性展开成 addEffect
  skills/                             内置技能（英文 Markdown）与按场景挑选的规则
  draft.ts                            草稿计划 → AiOps
  runtime.ts                          调用模型：草稿（结构化输出 + 修正重试）、对话智能体（工具）
  changes.ts                          改动清单
  history.ts                          对话记录文件（消息树、卡片结局、本工程记忆）
  memory.ts                           范例、记忆的挑选规则与提示词里的“Memory”一节
  compact.ts                          长对话压缩
  eval/                               一致性评测
src-tauri/crates/ai-gateway/          后端：配置、Key、流式代理、对话记录文件
```

调用链：

```
界面 → runtime（AI SDK）→ proxyFetch → Tauri 命令 ai_fetch → ai-gateway::forward → 模型接口
                                                     ↑ 校验地址、丢弃前端认证头、注入系统凭据库里的 Key
模型输出 AiOps → zod 宽松解析 → compile 试运行（语义校验）→ 有错：错误说明回传模型重试
                                                         → 无错：暂存 → 审阅 → 写入（一步撤销）
```

### 2.1 安全

- API Key 只存在系统凭据管理器（服务名 `art-net-studio.ai`），不写进 `data/ai-profiles.json`、日志，也不返回给界面。
- 前端的 SDK 用占位 Key；后端只转发白名单里的请求头（`content-type`、`accept`、`anthropic-version`、`anthropic-beta`），再按协议注入 `Authorization: Bearer` / `x-api-key` / `x-goog-api-key`。
- 请求地址必须与配置的接口地址同协议、同主机、同端口，路径在其之下；只允许 HTTPS，HTTP 仅限本机与局域网（Ollama、LM Studio）。
- 请求体上限 8 MiB，响应上限 64 MiB；可随时取消。
- 发给模型的工程摘要不含文件路径；输出目标与 IP 只在模型调用 `get_output` 时给出。

## 3. 减小不同模型之间的差异

| 措施 | 做法 |
|---|---|
| 中间语言 | 模型不写工程 JSON，只写 AiOps 操作列表；数值由编译器决定 |
| 受控词汇 | 特效从特效库选、模板从模板库选；颜色用 20 个命名色、`#rrggbb` 或色温；周期 / 大小 / 错开 / 速度 / 淡入淡出都是档位 |
| 量化 | 时间按 1/4 拍（没有节拍时 0.1 秒）再按输出帧对齐；颜色在 HSV 上按色相 5°、饱和度 / 明度 5% 对齐；强度 5%；属性 0.01 |
| 别名 | 上下文里不出现 UUID，别名由工程内容决定，同一工程每次相同 |
| 可移植 schema | 所有字段必填（可省略的为 `null`）、对象封闭、`anyOf` 代替 `oneOf`、`const` 改成单值 `enum`，范围与正则写进说明，由我们自己的 zod 兜底 |
| 修正重试 | 结构不对或语义错误时把说明回传模型，最多 3 次 |
| 草稿分级 | 一键草稿只让模型给出“每段能量 + 灯光 + 动作 + 颜色”，再确定性展开；比完整操作列表一致得多 |
| 配方 | “副歌爆发”“抒情铺底”这类整段编排用一个配方 id 表达，特效、周期、错开、摇头灯动作由配方决定（见 4.5） |
| 内置技能 | 编排知识（段落 → 能量 → 配方、情绪 → 调色板、口语 → 档位…）按确定的规则注入提示词，同一请求在各模型上看到的提示词相同（见 4.6） |
| 记忆与范例 | 偏好、笔记与用户认可过的改动按确定的规则放进提示词，模型照着同一份示例写（见第 7 节） |
| 长对话压缩 | 较早的轮次去掉工具细节，按固定规则处理，不再调用模型做摘要（见 7.4） |
| 生成参数 | 温度默认 0；接口支持时固定种子；提示词带版本号 |
| 评测 | 固定用例，在“特征”层面比较各模型与同一模型多次的结果（见第 6 节） |

## 4. AiOps 规范

一批操作：`{ summary, ops: AiOp[] }`，最多 64 条。字段写 `null` 表示用默认值。

### 4.1 引用

- 灯具 `F#`、分组 `G#`、轨道 `T#`、片段 `C#`、段落 `S#`、标记点 `M#`、素材库模型 `L#`；
- `all`：全部灯具（没有成员相同的分组时新建一个“全部灯具”分组）；`movers`：有 Pan 的灯具；
- `selection`：用户选中的片段；
- `new_<名字>`：同一批里 `createGroup` / `addFixtures` 新建的对象。

### 4.2 时间

`12.5s`、`b17`（第 17 小节）、`b17:3`（第 3 拍）、`S2` / `S2:end`、`M1`、`start`、`end`、`playhead`。偏移量：`+2bars`、`-1beats`、`+0.5s`。

### 4.3 操作

| 操作 | 作用 | 敏感 |
|---|---|---|
| `addEffect` | 放一个特效（特效库），可给颜色、周期、大小、错开、反向、对称 | |
| `addLook` | 自定义外观：强度（固定 / 波形 / 关键帧）、颜色（固定 / 序列 / 多色铺开 / 关键帧）、Pan/Tilt、其它属性 | |
| `applyTemplate` | 放一个 Cue 模板 | |
| `applyRecipe` | 放一个配方（灯光层 + 可选的摇头灯动作），可给颜色或调色板 | |
| `editCues` | 改已有片段：颜色、亮度、速度、大小、淡入淡出、名称、标签、禁用 | |
| `moveCues` / `resizeCues` / `splitCues` / `deleteCues` / `clearRange` | 时间线编辑 | 删除超过 20 个片段时敏感 |
| `addSection` / `addMarker` / `setTempo` / `createGroup` | 结构 | |
| `addFixtures` / `patchFixtures` / `setOutput` | 灯具配接与输出 | 是 |

放片段的操作默认 `replace: true`：先清掉目标轨道在这段时间里的片段。

### 4.4 新增一种操作

1. `opsSchema.ts`：加 zod 对象并放进 `aiOpSchema`；可省略的字段用 `opt(...)`；
2. `compile.ts`：在 `runOp` 里实现，复用 `lib/` 的纯函数；失败用 `fail("...")`（英文，给模型看）；会改配接或输出的加进 `SENSITIVE_OPS`；
3. `prompt.ts`：需要时补规则或示例，并递增 `PROMPT_VERSION`；
4. `__tests__/compile.test.ts` 加用例；`vocab.test.ts` 的可移植 schema 守卫会检查新结构。

### 4.5 配方

`applyRecipe { recipe, target, from, to, colors, palette, movers }` 展开成一到两个 `addEffect`：

| 配方 | 能量 | 灯光层 | 摇头灯动作 |
|---|---|---|---|
| `introBuild` | 低 | 渐亮（依次） | 垂直慢扫，16 拍，小幅 |
| `balladBed` | 低 | 呼吸，8 拍，中等淡入 | 水平慢扫，16 拍，小幅 |
| `breakdownCalm` | 低 | 流动渐变，16 拍（不能变色时改呼吸） | 无 |
| `verseGroove` | 中 | 强度波浪，2 拍，错开一半 | 画圆，8 拍，小幅 |
| `chorusBurst` | 高 | 颜色追逐，1 拍，完全错开，短淡入（不能变色时改强度追逐） | 扇形展开，4 拍，大幅 |
| `dropHit` | 高 | 每小节一次爆闪冲击 | 大幅摇摆，4 拍，大幅 |
| `finaleFade` | 低 | 渐暗（依次） | 无 |

- 颜色：给了 `colors` 用它，否则取 `palette` 的前三个颜色，都没有时用特效自己的颜色；不能变色的目标不带颜色。
- 摇头灯动作：`movers` 为 `null` 时只在目标是 `all` 时加；目标是 `movers` 时不加；工程没有摇头灯时跳过（显式要求时给警告）。
- 一键草稿的 `light` 也可以写配方 id，但草稿里配方不带动作，动作仍由计划的 `move` 决定。
- 对话里模型可以调用只读工具 `list_recipes`。改配方要递增 `RECIPES_VERSION` 与 `PROMPT_VERSION`。

### 4.6 内置技能

技能是 `ai/skills/*.md` 里的英文说明，由 `selectSkills` 按确定的规则挑选，接在系统提示词后面（“Guides for this request”）：

| 技能 | 内容 | 注入条件 |
|---|---|---|
| `phrases` 口语词表 | “快一点”“暗一点”“柔和”“炸”“这个 / 这里”等 → 固定的档位与引用 | 对话总是注入 |
| `songStructure` 歌曲编排 | 段落名 → 能量 → 配方，相邻段落的对比 | 草稿总是注入；对话里提到段落、歌曲结构时 |
| `colorMood` 颜色与情绪 | 情绪词 → 调色板与命名色，颜色数量 | 草稿总是注入；对话里提到颜色、情绪时 |
| `movers` 摇头灯动作 | 能量 → 位置特效、周期、幅度 | 工程有摇头灯，且是草稿、提到动作或提到段落 |
| `editClips` 修改片段 | 先查后改、只改要求的字段、改色保留特效 | 有选中片段，或提到改 / 换 / 删 / 快 / 慢 / 亮 / 暗等 |
| `patchOutput` 配接与输出 | 敏感操作、地址与 universe、输出模式 | 提到配接、地址、universe、输出、添加灯具时 |

- 技能不让模型自己选择读取（那样不同模型读的内容不同，反而增加差异），也不依赖某一家的专有功能。
- 对话里按用户最后一句话挑选，草稿按描述挑选；评测可以关掉技能做对照（见第 6 节）。
- 改技能内容或挑选规则要递增 `SKILLS_VERSION` 与 `PROMPT_VERSION`；`__tests__/skills.test.ts` 固定了挑选结果。

## 5. 对话记录

- 库外工程：工程旁的 `<文件名>.ai.json`；
- 节目库里的工程：`data/ai-history/lib-<路径散列>.ai.json`（节目改名后不再关联）；
- 未保存的工程：只在内存里，第一次保存或另存为时写盘；
- 格式第 2 版（`ai/history.ts`）：`version`、`promptVersion`、`profileId`、`tree`（`{ parentId, message }`，编辑重发与重新生成产生的各个版本）、`headId`（当前看的版本）、`proposals` / `memoryCards`（提议卡片与记忆卡片的结局）、`notes` / `exemplars`（本工程的记忆）。第 1 版文件读入时当作一条线；
- 上限：当前版本 200 条、整棵树 400 条。超出时先删当前版本最早的消息（连同挂在它们上的其它版本），再从最早的、不在当前版本上的分支删起，整个分支一起删；
- 打开对话时整棵树经 assistant-ui 的 `messageRepository` 灌入一次；之后当前版本的每次变化（包括切换版本）并进树里，1 秒后写盘。发给模型的只有当前版本。

## 6. 一致性评测

- **CI**（`npm run verify` 里）：`ai/eval/__tests__/replay.test.ts` 回放 `ai/eval/recordings/` 里录下的模型输出，确认编译结果的特征不变；编译规则有意改动后需要重新录制。
- **真实调用**（手动）：在仓库根目录建 `ai-eval.config.json`（已加入 `.gitignore`），Key 放环境变量：

  ```json
  { "runs": 3, "models": [
    { "name": "deepseek", "kind": "openaiCompatible", "baseUrl": "https://api.deepseek.com/v1", "model": "deepseek-chat", "keyEnv": "DEEPSEEK_API_KEY", "seed": 7 },
    { "name": "qwen", "kind": "openaiCompatible", "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1", "model": "qwen-plus", "keyEnv": "DASHSCOPE_API_KEY", "supportsStructuredOutputs": true },
    { "name": "claude", "kind": "anthropic", "baseUrl": "https://api.anthropic.com/v1", "model": "claude-sonnet-4-5", "keyEnv": "ANTHROPIC_API_KEY" }
  ] }
  ```

  运行 `npm run ai:eval`，报告写到 `ai-eval/report.md`：成功率、平均尝试次数、耗时、自身一致度、期望满足率、检查通过率，以及模型两两之间的一致度。
  加 `AI_EVAL_RECORD=1` 时把每次的输出录进 `recordings/`。
  `AI_EVAL_SKILLS=both` 时每个模型分别跑“注入技能”和“不注入技能”两遍，报告末尾给出两者在跨模型一致度、自身一致度、期望满足率、检查通过率上的差值；`off` 只跑不注入的版本，默认 `on`。
- **用例**：
  - 一键草稿（`EVAL_CASES`）：流行、抒情、电子、纯调光、无节拍演讲等；
  - 对话编辑（`EDIT_CASES`）：在已有片段的工程上改副歌颜色、把选中片段加速一倍、主歌调暗、副歌加摇头灯动作、尾声换成冷色呼吸。走对话智能体，取最后一次 `propose_ops` 的结果计算特征；
    每个编辑用例带手写的参考答案，CI 里确认参考答案满足全部期望与检查、而原工程不满足，保证检查本身有效。
- **特征**：每个段落的主要特效类别、主色调（8 个色相区或白光）、亮度档位、有没有动作。一致度是逐段逐项相同的比例。编辑用例另有特征表达不了的检查（特效是否保留、周期是否减半）。
- 用例在 `ai/eval/__tests__/cases.ts`，只增不改。

## 7. 记忆

参考了 ChatGPT Memory（回复下方的记忆来源、“不要再提”即停用而不删除）与 Claude 的 memory tool（记忆限定在固定目录、按工程记笔记）。
和后者不同，记忆不由模型自己决定读哪些，而是由代码按确定的规则放进提示词：同一个请求、同一份记忆，在任何模型上看到的提示词完全相同。
不用向量检索（不同的向量模型检索出的内容不同，也需要额外的服务）。

### 7.1 种类

| 种类 | 内容 | 存在哪里 | 上限 | 放进提示词 |
|---|---|---|---|---|
| 个人偏好 | “不要频闪”“偏暖色”“回复简短” | `data/ai-history/memory-user.ai.json` | 30 条，每条 200 字 | 对话与草稿都放，启用的全部放入 |
| 本工程笔记 | “G1 是前排帕灯”“副歌都用蓝紫” | 工程的对话记录（`notes`） | 30 条，每条 200 字 | 同上 |
| 本工程范例 | 在对话里应用过的改动：用户的话 → 操作 | 工程的对话记录（`exemplars`） | 50 个 | 只在对话里，按这句话挑最相关的 |
| 共用范例 | 同上，但不含灯具 / 分组 / 轨道 / 片段 / 标记点 / 素材库模型别名 | `data/ai-history/memory-exemplars.ai.json` | 100 个 | 同上，与本工程范例一起挑 |

- 每条记忆都有启用开关；停用的保留着，但不放进提示词，也不参加挑选。
- 范例只记对话里的改动，要在用户应用后才记；草稿的改动不记。操作序列化后超过 1200 字符的不记，值为 `null` 的字段去掉。同一句话只保留最新的一个。

### 7.2 写入

- 模型调用 `remember { scope: "user" | "show", text }`，对话里显示记忆卡片，用户点“保存”才写入（`user` 进个人偏好，`show` 进本工程笔记），“忽略”不写；同样的内容不重复存。
- 提示词规定只有用户明确要求（“记住……”），或说出长期偏好（“以后都……”“总是……”“不要再……”）时才调用，一件事一次。
- 用户也可以在记忆页（本工程）和设置 → AI 助手（个人偏好）里直接增删改。

### 7.3 放进提示词

接在技能后面的“Memory”一节，依次是个人偏好、本工程笔记、用户认可过的范例（写成 `"用户的话" → propose_ops({...})`，提醒模型里面的别名可能过时，要重新查）。

- 范例挑选：把这句话与范例里用户的话切成词（中日韩文字取单字与相邻两字，其它按单词），算 Dice 相似度，至少 0.3 才选；按相似度从高到低、同分时新的在前，最多 3 个。本工程与共用范例里同一句话只取本工程的。
- 这一轮用到的记忆（类别 + id）经 AI SDK 的 `messageMetadata` 挂在回复上，回复下方显示“参考了 N 条记忆”，可以直接停用或删除；随对话记录保存。
- 用户问“你记得什么”时，提示词要求只按“Memory”一节回答。
- 一键草稿只带个人偏好与工程笔记。评测（`npm run ai:eval`）不带记忆，技能开 / 关的对比不受影响。

### 7.4 长对话压缩

发给模型之前（`ai/compact.ts`，在智能体的 `prepareCall` 里）：

- 最近 4 轮（从用户的一句话到下一句之前）原样保留；
- 更早的轮次保留用户消息与助手的文字；`propose_ops` 换成 `[proposed a change: <summary> (applied / discarded / replaced / pending)]`，`remember` 换成 `[asked to remember: "<text>" (saved / ignored / pending)]`，其它工具调用、工具结果与推理过程删掉；
- 仍然超过 40 条时，从最早的压缩部分按整轮删起（保留的 4 轮不动，避免拆开工具调用与结果）。

规则确定，不调用模型做摘要；同样的输入总是得到同样的结果。

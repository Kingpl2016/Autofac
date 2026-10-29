# Open Fixture Library 适配说明

本文说明 Art-Net Studio 怎样把 [Open Fixture Library](https://open-fixture-library.org/)（OFL）的灯具定义变成本软件的物模型，以及节目编辑器怎样驱动这些灯具。
实现代码在 `src-tauri/crates/show-engine/src/fixture/ofl.rs`（单个灯具）和 `fixture/ofl_bundle.rs`（整库）里，引擎部分在 `compile.rs`、`eval.rs`、`mix.rs` 里。

## 1. 导入入口

| 入口 | 用法 | 说明 |
|---|---|---|
| 灯具库 → 导入文件 | 选择一个或多个 OFL `.json` | 逐个导入。失败的文件会列在导入结果里，不影响其它文件 |
| 灯具库 → 浏览 OFL 库 | 选择官方仓库的 zip，或解压后的文件夹 | 先建一个轻量目录，再搜索、勾选后导入，见第 5 节 |

导入后的模型带有来源信息 `source = { kind: "ofl", key: "制造商/灯具", recognizer }`。`recognizer` 是导入时的识别规则版本，当前为 `OFL_RECOGNIZER_VERSION = 2`。

## 2. 通道功能识别

### 2.1 能力类型映射

一个通道有若干能力区间（capability），每个区间按 OFL 的 `type` 映射到一个通道功能：

| OFL 能力类型 | 通道功能 |
|---|---|
| `Intensity` | 调光 `dimmer` |
| `ColorIntensity` | 按 `color` 映射：Red / Green / Blue / White / Warm White / Cold White / Amber / UV / Lime / Indigo / Cyan / Magenta / Yellow |
| `ColorPreset` | 色轮 `colorWheel` |
| `ColorTemperature` | 色温 `colorTemp` |
| `Pan`、`PanContinuous` / `Tilt`、`TiltContinuous` | `pan` / `tilt` |
| `PanTiltSpeed` | 云台速度 `speed` |
| `ShutterStrobe`、`StrobeSpeed`、`StrobeDuration` | 快门 `shutter` |
| `WheelSlot`、`WheelRotation`、`WheelSlotRotation`、`WheelShake` | 按轮子类别取值，见 2.3 |
| `Prism` / `PrismRotation` | `prism` / `prismRotate` |
| `Frost`、`FrostEffect` | `frost` |
| `Focus` | `focus` |
| `Zoom`、`BeamAngle` | `zoom` |
| `Iris`、`IrisEffect` | `iris` |
| `BladeInsertion` / `BladeRotation`、`BladeSystemRotation` | `blade` / `bladeRotate` |
| `Rotation` | `rotation` |
| `Fog`、`FogOutput`、`FogType` | `fog` |
| `EffectSpeed`、`EffectDuration`、`Speed`、`Time` | 程序速度 `effectSpeed` |
| `Effect`、`EffectParameter`、`SoundSensitivity` | 宏 `macro` |
| `Maintenance` | 注释含 “reset” 时为 `reset`，否则为 `maintenance` |
| `NoFunction`、`Generic`、未知类型 | 不参与识别 |

本轮新增的功能有：`indigo`、`colorWheelRotate`、`blade`、`bladeRotate`、`rotation`、`fog`、`effectSpeed`、`maintenance`。`indigo` 是一种新的发光体，参与混色。

### 2.2 投票规则

一个通道的功能由各能力区间按覆盖的 DMX 宽度投票决定，票数相同时取先出现的那个。旧规则是“第一个能力决定功能”，常常因为通道开头的一小段“无功能”或“宏”被识别错，现已废弃。投票还有以下附加规则：

- 选槽通道上的抖动、旋转区间并入选槽，例如图案轮上的“图案 3 抖动”算作图案：
  - `goboShake`、`goboRotate` 并入 `gobo`；
  - `colorWheelRotate` 并入 `colorWheel`；
  - `prismRotate` 并入 `prism`。
- `macro`、`effectSpeed`、`maintenance`、`reset` 是附加功能。通道上还有其它功能时，它们不参与比较。
- 所有能力都不参与识别时，按通道名识别。`Color`、`Speed` 这类含糊的名字不识别，最后归为 `other` 并给出“功能未识别”警告。

### 2.3 轮子

轮子名默认取 `wheel` 字段，省略时取通道名。轮子类别由槽位的多数类型决定（Color / Gobo / Prism / Iris / Frost）。没有槽位信息时，按轮子名里的关键字判断，都不匹配就当作图案轮。

| 能力 | 颜色轮 | 棱镜轮 | 其它（图案） |
|---|---|---|---|
| `WheelSlot` | `colorWheel` | `prism` | `gobo`（光圈 / 雾化轮为 `iris` / `frost`） |
| `WheelRotation` | `colorWheelRotate` | `prismRotate` | `goboRotate` |
| `WheelSlotRotation` | `goboRotate` | `prismRotate` | `goboRotate` |
| `WheelShake` | `goboShake` | `goboShake` | `goboShake` |

### 2.4 能力标签

能力区间上保留语义标签 `tag`，供引擎和界面使用：

| 标签 | 来源 |
|---|---|
| `shutterOpen` / `shutterClosed` / `strobe` | `ShutterStrobe` 的 `shutterEffect` 为 Open / Closed / 其它 |
| `slot` | `WheelSlot` |
| `rotation` | 带速度的轮子 / 棱镜 / 通用旋转 |
| `effect`、`maintenance`、`noFunction` | 同名能力类型 |

快门没有 `defaultValue` 时，默认值取“开光”区间的中点，否则摇头灯默认不出光。

### 2.5 重复功能的降级

本软件要求同一像素里的“唯一功能”（例如 `red`、`dimmer`）只出现一次。OFL 里常见两个通道识别成同一功能，例如两个色轮。现在这种情况下，第二个及之后的通道降级为 `other`，并给出 `duplicateFunctionDemoted` 警告。旧行为是拒收整台灯。

### 2.6 结构特性

| 特性 | 处理 |
|---|---|
| 精细通道（`fineChannelAliases`） | 紧跟粗调通道时合并为 16 位；24 位的第二级精细通道保留为独立通道，并给出 `fineChannelTruncated` 警告；不紧跟粗调的精细通道独立导入并告警 |
| 模板通道（`templateChannels`、`$pixelKey`） | 按矩阵展开，包括模板精细通道和模板 switchChannels |
| `switchChannels` | 按依赖通道的默认值解析成实际通道 |
| `dmxValueResolution` | 按定义的分辨率换算到通道位宽 |
| 矩阵与像素组（`pixelGroups`） | 见 3.1 |
| 重定向文件（`redirectTo`） | 单文件导入时返回 `Redirect` 错误，提示改选目标灯具；整库导入时自动跟随，链长上限 8 |
| 物理参数（`physical`）与能力物理量 | 导入为模型物理参数和能力区间的起止物理量；`narrow`、`wide` 这类关键字按百分比换算 |
| 无法使用的模式（含不支持的插入块等） | 跳过整个模式并给出 `modeSkipped` 警告，避免通道错位 |
| 模式数 | 单个模型最多 32 个模式（`MAX_MODES`，Rust 与 `validate.ts` 一致）。OFL 像素灯常有二三十个模式；超出的模式跳过，并给出 `unsupportedFeature` 警告（官方库里有 6 个灯具超过 32 个模式） |

导入警告按类型分组显示在导入结果对话框里。类型包括 `unknownFunction`、`unknownChannel`、`fineChannelTruncated`、`duplicateFunctionDemoted`、`capabilityDropped`、`pixelGroupsAsHeads`、`modeSkipped` 等。

## 3. 像素与多头灯

### 3.1 像素编号

- 有矩阵的灯具，按像素在模式通道里出现的顺序编号为像素 1、2、3……（物模型通道的 `head` 字段）。`head = 0` 表示整灯本体，例如总调光、快门、Pan / Tilt。
- 按像素组控制的模式，组按出现顺序编号，并给出 `pixelGroupsAsHeads` 警告。如果一个组覆盖全部像素，而模式里还有其它控制单元，这个组视为整灯（head 0）。
- 像素键带空洞的矩阵保留网格位置。

### 3.2 像素引用

分组成员、灯具轨道和场景条目里的“灯具 id”可以是两种引用：

| 引用 | 写法 | 含义 |
|---|---|---|
| 整灯 | `f12` | 整台灯具，包含它的全部像素 |
| 像素 | `f12#3` | 灯具 `f12` 的像素 3（像素号与 `head` 一致，从 1 起） |

灯具 id 由 `newId()` 生成，不含 `#`，所以 `#` 不会产生歧义。前端工具函数集中在 `src/features/show-editor/lib/fixtureRef.ts`：`parseRef`、`refOf`、`baseOf`、`headsOf`、`pixelRefsOf`、`refExists`、`refName`、`prunePixelRefs`。

工程文件版本升到 4（迁移 `MIGRATIONS[3]`）。灯具换模式、更新模型快照、删除灯具之后，会在同一次撤销步骤里清理失效的像素引用：

- 从分组里移除失效引用；分组成员少于 2 个时，分组连同它的轨道一起删除；
- 删除绑定失效像素的轨道及其片段；
- 删除失效的场景条目。

打开工程时，`parseProject` 也会先做一次清理，再做完整性检查。

### 3.3 引擎行为

- **拆分**：带矩阵且布局里用到像素的模型，编译成“整灯本体 + 各像素成员”。本体拥有 head 0 的通道，像素 `n` 的编号为 `灯具id#n`，拥有自己的发光体和属性通道。
- **整灯引用的展开**：整灯引用展开为本体加全部像素，它们共用一个分布（spread）位置。因此给整灯写外观时，输出与不拆分时一致。
- **调光耦合**：本体有总调光、像素只有发光体时，像素混色器使用外部调光（`with_external_dimmer`）。每帧：
  - 总调光取本体和各像素级别中的最大值；
  - 各像素发光体按“像素级别 ÷ 总调光”缩放，亮度不会重复计算；
  - 只控制某个像素时，其余像素保持暗。
- **合成**：整灯片段和像素片段沿用现有的 HTP / LTP 规则合成。
- **舞台**：舞台上每台灯只画一个点。拆分后的整灯显示各像素的平均色；选中像素时，高亮它所属的灯具。

### 3.4 编辑器操作

- **Patch 列表**：多头 / 像素灯可以展开出像素行（点三角，或在灯具行上按 →；← 回到灯具行或收起）。像素行和灯具行一样支持单击、Ctrl、Shift 选择。
- **所选像素的操作**：可以“为所选像素建轨道”（已有轨道的像素不重复建）和“用所选像素建组”。像素组可以像普通分组一样做追逐、渐变等分布效果。
- **编程器**：编程器可以给像素单独设强度和颜色。记录成场景片段时，条目按“每台灯先整灯、再各像素”的顺序写入。
- **色盘的“实际输出”**：
  - 选中像素时，按该像素给出发光体推子和预览色；
  - 选中整灯而发光体都在像素里（像素灯条）时，取第一个有发光体的像素作代表。

## 4. 无发光体灯具的驱动

| 功能 | 规则 |
|---|---|
| 反向通道（`invert`） | 被混色器驱动的发光体、调光、开关通道也按反向输出（写入 `1 - 分数`） |
| CMY | 颜色层按峰值归一化后只表达色相与饱和度，亮度交给调光；C / M / Y 取 `1 - 分量` |
| 色轮 | 选线性 RGB 距离最近的带颜色槽位，写入该槽位区间的中点；`Open` 槽位视为白色 |
| 快门跟随强度 | 快门同时标注了开光与关光区间时，如果本帧没有外观显式写快门，灯暗时快门取关光区间中点，灯亮时取开光区间中点。强度层的频闪（方波曲线）因此也能驱动机械快门 |

规则说明：

- 属性层显式写入的 CMY、色轮、快门总是优先，派生只填没有被写过的通道。
- 按发光体直给的颜色（manual）不派生 CMY / 色轮。
- 预览色对 CMY / 色轮灯按滤色计算：CMY 取 `1 - 值`，色轮取当前槽位颜色，两者相乘。

## 5. 整库目录导入

1. 在“浏览 OFL 库”里选择 OFL 官方仓库的 zip（例如 GitHub 的 `master.zip`），或解压后的文件夹。
2. 后端读取 `manufacturers.json` 得到制造商显示名，跟随重定向，生成轻量目录。目录只记录名称、分类、各模式通道数等摘要，保存在数据根目录下的 `ofl-catalog.json` 里，重启后仍可浏览。建目录的进度通过 `ofl:catalog-progress` 事件报告。
3. 在对话框里按关键字、制造商、分类、状态筛选。关键字按空白分词，每个词都要出现在名称、制造商、标识或分类里。每一项标出它在库里的状态：
   - `new`：库里还没有；
   - `imported`：已用当前识别规则导入；
   - `outdated`：用旧规则导入或来源不明，可以重新导入。
4. 勾选后导入。导入时按目录记录的路径重新打开包并核对指纹，全部解析完后一次性合并进灯具库。进度通过 `ofl:import-progress` 事件报告，结果里列出成功、警告和失败项。
5. 已导入的模型更新后，节目编辑器顶部会提示“灯具模型在素材库里有更新”。点“查看并更新”确认后，才会更新工程里的模型快照，同时清理失效的像素引用。工程不会被静默修改。

安全限制（`ofl_bundle.rs`）：

| 项 | 上限 |
|---|---|
| 灯具文件数 | 20000（`MAX_BUNDLE_FIXTURES`） |
| 单个灯具 JSON | 5 MiB（`MAX_FIXTURE_BYTES`） |
| 解压总量 | 512 MiB（`MAX_BUNDLE_BYTES`） |
| 重定向链 | 8 层 |
| 文件夹遍历深度 | 6 层 |
| 每页查询条数 | 500 |

此外，zip 条目名必须是安全的相对路径，解压只在内存里进行，不写磁盘。如果包在建立目录之后被修改或移走，导入时会报“OFL 包已变化，请重新打开”。

## 6. 回归样本与验证

- **样本**：`src-tauri/crates/show-engine/tests/fixtures/ofl/` 里的灯具 JSON 取自 OFL 官方仓库 `fixtures/` 目录（`master` 分支，2026-10-29 下载），未做修改，以 MIT 许可发布。各文件覆盖的特性见该目录的 `README.md`。测试入口为 `tests/ofl_samples.rs`。
- **整库回归**（默认忽略，需要先下载官方 zip）：

  ```
  OFL_ZIP=src-tauri/target/ofl-master.zip cargo test -p show-engine --release --test ofl_samples 整库 -- --ignored --nocapture
  ```

  当前结果：目录 665 项（137 个制造商，含重定向文件，0 个损坏），导入 652 个模型，0 个失败。默认模式共 4533 个通道，其中 152 个仍归为“其他”，主要是 Hue / Saturation、CIE x/y、绿-品红校正这类本软件还没有对应功能的通道。
- **前端用例**：
  - `fixtureRef.test.ts`：像素引用与迁移；
  - `modelUpdates.test.ts`：模型快照更新；
  - `PatchPanel.test.tsx`：像素行；
  - `programmer.test.ts`：像素编程；
  - `colorMath.test.ts`：像素灯条混色预览；
  - `perf.test.ts`：32 台 × 16 像素追逐，每帧低于 8 ms。

## 7. 与原计划的差异

| 计划 | 实际 | 原因 |
|---|---|---|
| 灯具库列表（`FixtureList` / `LibraryFixturesTab`）做虚拟滚动 | 只给 OFL 目录对话框做了虚拟滚动 | 按需勾选导入后，库里的模型数量不大，普通列表就够用 |
| 前端“频闪生成器”写 `attrs.shutter` | 改为引擎端的快门跟随强度（`shutter_gate`） | 前端生成器处理不了混合机型的分组；引擎端按每台灯自己的开光 / 关光区间换算，对任何轨道和分组都成立 |
| 舞台画出像素子点 | 舞台每台灯只画一个点，显示像素平均色 | 按评审时的选择（3=b），舞台保持整灯视角，像素在 Patch 和时间线里操作 |
| 黄金向量加入像素追逐用例 | 用引擎单元测试“像素组成分组时分布按像素铺开”覆盖 | 共用的黄金向量格式（Rust 与 TS 两套解析）不描述矩阵和像素，扩展格式的成本大于收益 |

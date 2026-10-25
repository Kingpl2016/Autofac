---
inclusion: fileMatch
fileMatchPattern: '**/*.rs'
---

# Rustdoc 文档注释规范

本项目所有 Rust 代码的文档注释统一用 **rustdoc**，并对带参数的函数/方法补 **参数注释**。目标是 `cargo doc` 可生成完整 API 文档、IDE 悬浮提示可读、评审无需跳转实现即可理解契约。与 `tech.md`（编码约定）互补——本文件是文档注释的权威细则。

## 铁律速查

1. **公开项一律 rustdoc，不用行注释**：所有 `pub` 项（模块、`struct`/`enum`/`trait`/`fn`/`type`/`const`、结构体字段、枚举变体、trait 方法）用 `///`（模块用 `//!`）文档注释，**不用** `//` 行注释描述公开 API。`//` 仅用于实现内部的解释性旁注。
2. **带参数必写 `# Arguments`**：只要函数/方法/关联函数有参数（`&self`/`&mut self` 除外），就用 `# Arguments` 小节逐个说明每个参数的语义、单位、取值约束。
3. **返回 `Result` 必写 `# Errors`**：说明在什么条件下返回 `Err` 及返回哪个 `GatewayError`/错误类型变体（clippy `missing_errors_doc` 依赖此小节）。
4. **可能 panic 必写 `# Panics`**：库 crate 本就禁 `unwrap`/`expect`/`panic!`，若确有 panic 路径（仅测试/`main`）须写明。
5. **中文描述，标识符保留英文并加反引号**：描述用简体中文；类型名、参数名、字段名、枚举变体、crate 名等标识符保留英文并用反引号包裹（如 `` `node_name` ``、`` `Arc<str>` ``）。
6. **rustdoc 小节标题用英文**：`# Arguments` / `# Returns` / `# Errors` / `# Panics` / `# Examples` 用标准英文标题（与既有 `# Errors` 用法一致、被工具识别），标题下正文用中文。
7. **返回非 `()` 必写 `# Returns`**：函数/方法返回值不是 `()` 时，用 `# Returns` 小节说明返回值的语义、可能的取值范围与特殊情况（如 `None` / `Some` 的含义）。返回 `Result` 时 `# Returns` 描述 `Ok` 分支语义，`# Errors` 描述 `Err` 分支。仅返回 `Result<(), _>` 时可省略 `# Returns`（`Ok(())` 语义已由概述句隐含）。

## 各类项写法

### 模块

文件顶部 `//!` 模块级文档：一句话说明模块职责，必要时补充设计动机、与权威文档的对应锚点。

```rust
//! 反控写入结果与地址 / 写值校验错误值对象。
//!
//! `WriteResult` 承载一次反控写入的成功 / 失败信息……
```

### 函数 / 方法 / 关联函数

结构：**概述句** → `# Arguments`（有参数时）→ `# Returns`（返回非 `()` 时）→ `# Errors`（返回 `Result` 时）→ `# Panics`（有 panic 路径时）→ `# Examples`（可选）。

参数逐条用 `* \`名\` - 说明`：

```rust
/// 把不透明 `params` 反序列化为类型化配置 `T`。
///
/// # Arguments
///
/// * `params` - Host 原样转交的不透明驱动私有配置（`serde_json::Value`）。
///
/// # Errors
///
/// 当 `params` 无法反序列化为 `T` 时返回 [`GatewayError::InvalidDriverConfig`]，
/// 其描述为底层 serde 错误的 `Display`。
pub fn config_from_value<T: DeserializeOwned>(
    params: serde_json::Value,
) -> Result<T, GatewayError> { /* ... */ }
```


返回非 `()` 的 `Option` / 具体类型方法须补 `# Returns`：

```rust
/// 返回指定插件经握手上报的 [`DriverSchema`]。
///
/// # Arguments
///
/// * `plugin_id` - 目标插件类型唯一标识。
///
/// # Returns
///
/// 若 `plugin_id` 已注册且该插件上报了非空 `schema_json`，返回
/// `Some(&DriverSchema)`；否则返回 `None`（插件未注册或未上报 schema）。
pub fn get_schema(&self, plugin_id: &str) -> Option<&DriverSchema> { /* ... */ }
```

返回 `Result<T, E>`（`T` 非 `()`）时 `# Returns` 描述 `Ok` 分支，`# Errors` 描述 `Err` 分支：

```rust
/// 跨库直调插件的 `read_group`，await 其 `DynFuture`，返回一次采集快照。
///
/// # Arguments
///
/// * `group` - 目标点位分组。
///
/// # Returns
///
/// 成功时返回该 Group 的 [`TagGroupSnapshot`]（由镜像 DTO 转回的 host owned 值）。
///
/// # Errors
///
/// - 插件 `catch_unwind` 捕获 panic 时返回 [`GatewayError::PluginPanic`]。
/// - 驱动连接异常时返回 [`GatewayError::DriverConnection`]。
pub async fn read_group(&self, group: &TagGroup)
    -> Result<TagGroupSnapshot, GatewayError> { /* stabby AbiDriver 直调 */ }
```
trait 方法即使无默认实现体，也须写完整概述 + `# Arguments` + `# Errors`：

```rust
/// 读取一个 Group 的全部点位，返回一次采集的完整快照。
///
/// # Arguments
///
/// * `group` - 待读取的点位分组（含 `interval_ms` 与 `tags`）。
/// * `cancel` - 取消令牌；长操作须在取消时尽快返回。
///
/// # Errors
///
/// 读取失败（连接断开、协议错误等）时返回 [`GatewayError`]。
async fn read(
    &mut self,
    group: &TagGroup,
    cancel: CancellationToken,
) -> Result<TagGroupSnapshot, GatewayError>;
```

- `&self` / `&mut self` 不列入 `# Arguments`。
- 参数含单位/取值约束/哨兵值时必须写明（如 `` `interval_ms` - 采集周期（毫秒）；`0` 为按需组哨兵 ``）。
- 概述句已能完整覆盖唯一参数语义时，`# Arguments` 仍建议保留以统一风格；确无信息增量的平凡 setter 可省略（需团队一致）。

### 结构体 / 枚举 / 字段 / 变体

结构体/枚举本身写 `///` 概述；**每个** `pub` 字段与枚举变体写行内 `///`：

```rust
/// 点位分组：Node 下带统一采集周期的点位集合，也是南北向路由的最小单元。
pub struct TagGroup {
    /// 分组名。热路径 / 路由标识，用 `Arc<str>`。
    pub name: Arc<str>,
    /// 采集周期（毫秒）；`0` 为按需组哨兵，否则信封校验 `>= 100`。
    pub interval_ms: u32,
    /// 分组下的点位。
    pub tags: Vec<Tag>,
}
```

### 类型别名 / 常量

```rust
/// 投影后的物模型标准 payload（以 `serde_json::Value` 承载，避免耦合 `thing_model` 具体类型）。
pub type ThingModelPayload = serde_json::Value;
```

## 链接与交叉引用

- 引用其它项用 rustdoc 内链 `[`Type`]` / `[`Type::method`]`，让 `cargo doc` 生成跳转。
- 引用权威设计文档时写明相对路径锚点（如 `对齐 `data-collection.md §3.1``）。

## 校验

- 提交前 `cargo doc --workspace --no-deps` 应无 rustdoc 警告（坏链接、无效内链）。
- 建议在公开库 crate（`itgw-core`（含 `thing_model` 模块）/ `itgw-plugin` / `itgw-timeseries`）crate 根加 `#![warn(missing_docs)]`，强制公开项补文档。
- `# Errors` 缺失会被 clippy `pedantic` 的 `missing_errors_doc` 命中（workspace 已开 `clippy::pedantic = "warn"`）。

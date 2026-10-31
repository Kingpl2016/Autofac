//! 节目编辑引擎。
//!
//! 本 crate 是“节目编辑页”在后端的纯逻辑核心，不依赖 Tauri：
//!
//! - [`fixture`]：灯具物模型（通道属性、功能枚举、校验）、内置 6 类标准模型、
//!   物模型 Excel 导入与用户模型库的持久化。
//!
//! - [`media`]：音视频素材的探测（时长、音轨）、波形峰值与节拍分析的解码入口（symphonia，纯 Rust 解码）。
//! - [`beats`]：节拍分析（谱通量起音检测、自相关测速、动态规划跟拍、强拍相位、能量分段），纯计算。
//! - [`analysis`]：音乐结构分析（每小节特征、段落结构标签、渐强 / 爆点 / 断层 / 冲击事件），纯计算。
//! - [`project`]：节目工程（`ShowProject`）的后端镜像，与前端 `project.ts` 逐字段对应。
//! - [`mod@compile`] / [`eval`]：把工程编译成 [`CompiledShow`]，并在任意时刻渲染各 Universe 的 DMX 帧
//!   （静态 Cue、淡入淡出缓动、Gamma、HTP 合并）。
//! - [`mix`]：混色引擎（RGB / RGBW / RGBCW / RGBA / 冷暖白 / 单色的策略与工厂、色温换算、
//!   发光体校准、实际输出颜色）。
//! - [`effects`]：8 种参数化特效（呼吸、彩虹、追逐、擦除、渐变、脉冲、闪烁、频闪）的逐灯具求值。
//! - [`envelope`]：缓动曲线、淡入淡出包络与 Gamma 公式。
//!
//! 对应的需求见 `doc/核心板控制软件要求_D261024v1.0.md` §2.1 ~ §2.3、§2.7，
//! 物模型表结构见 `doc/DMX物模型表.xlsx`。

#![warn(missing_docs)]
// 测试里的浮点比较都是对精确可表示的值（0.5、1.0…）做断言
#![cfg_attr(test, allow(clippy::float_cmp))]

pub mod analysis;
pub mod beats;
pub mod compile;
pub mod effects;
pub mod envelope;
pub mod eval;
pub mod fixture;
pub mod look;
#[cfg(feature = "media")]
pub mod media;
pub mod mix;
pub mod project;

pub use compile::{compile, CompileWarning, CompiledShow, DmxData};
pub use eval::{Frame, FrameSet};
pub use project::{ShowProject, FRAME_MS, OUTPUT_FPS};

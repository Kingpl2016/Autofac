//! Art-Net 4 与 sACN (E1.31) 的数据包编解码与 UDP 收发。
//!
//! - [`artnet`]：ArtDmx / ArtPoll / ArtPollReply 编解码。
//! - [`sacn`]：E1.31 数据包编解码与组播地址计算。
//! - [`socket`]：多网卡绑定、sACN 组播加入、异步收发任务与 [`socket::DmxSender`]。
//! - [`frame`]：协议无关的 [`frame::DmxFrame`] 与 Port-Address 辅助。

pub mod artnet;
pub mod frame;
pub mod sacn;
pub mod socket;

pub use frame::{DmxFrame, Protocol};

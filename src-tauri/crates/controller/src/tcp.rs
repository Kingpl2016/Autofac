//! ESP32-P4 TCP 1227 指令客户端（按命令建立连接，收发单帧）。

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;

use crate::error::{ControllerError, Result};
use crate::protocol::{try_decode_stream, Frame};

/// 连接核心板，发送一帧指令，并在需要时读取一帧应答。
///
/// 采用"每命令一连接"的简单模型；后续可改为持久连接 + 重连。
///
/// # Arguments
///
/// * `host` - 核心板 IP 或主机名。
/// * `port` - 控制端口（通常 1227）。
/// * `frame` - 已编码的指令帧字节。
/// * `expect_response` - 是否等待应答帧。
/// * `timeout_ms` - 连接与收发的总超时（毫秒）。
///
/// # Returns
///
/// 需要应答且成功读到时返回 `Some(Frame)`；无需应答返回 `None`。
///
/// # Errors
///
/// 连接/读写失败返回 [`ControllerError::Io`]，超时返回 [`ControllerError::Timeout`]，
/// 应答帧非法返回解析错误。
pub async fn send_command(
    host: &str,
    port: u16,
    frame: &[u8],
    expect_response: bool,
    timeout_ms: u64,
) -> Result<Option<Frame>> {
    let dur = Duration::from_millis(timeout_ms);
    let fut = async {
        let mut stream = TcpStream::connect((host, port)).await?;
        stream.write_all(frame).await?;
        stream.flush().await?;

        if !expect_response {
            return Ok(None);
        }

        let mut buf = Vec::with_capacity(64);
        let mut chunk = [0u8; 512];
        loop {
            let n = stream.read(&mut chunk).await?;
            if n == 0 {
                return Err(ControllerError::Truncated);
            }
            buf.extend_from_slice(&chunk[..n]);
            if let Some((f, _used)) = try_decode_stream(&buf)? {
                return Ok(Some(f));
            }
        }
    };

    timeout(dur, fut).await.map_err(|_| ControllerError::Timeout)?
}

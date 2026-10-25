//! 基于 tokio 的 UDP 收发：多网卡绑定、sACN 组播加入、ArtDmx / sACN 发送。

use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4};
use std::time::Instant;

use socket2::{Domain, Protocol as S2Protocol, Socket, Type};
use tokio::net::UdpSocket;
use tokio::sync::mpsc;

use crate::artnet::{self, ArtNetPacket, PollReplyInfo, ARTNET_PORT};
use crate::frame::{DmxFrame, Protocol};
use crate::sacn::{self, SACN_PORT};

/// 接收缓冲区大小（足够容纳最大 Art-Net/sACN 包）。
const RECV_BUF: usize = 2048;

/// 判定一次 `recv_from` 错误是否为致命错误（需终止接收任务）。
///
/// UDP 上存在可恢复的瞬时错误：典型如 Windows 在先前 `send_to` 收到 ICMP
/// "端口不可达" 后，会让后续 `recv_from` 返回 `WSAECONNRESET`
/// （[`ErrorKind::ConnectionReset`]）。这类错误若直接 `break` 会导致接收任务
/// 永久退出、静默丢失该协议后续所有帧。此处将其与其他连接类/瞬时错误一并视为
/// 可恢复（继续接收），仅把真正无法继续的错误（如绑定地址失效）判为致命。
fn is_fatal_recv_error(e: &std::io::Error) -> bool {
    use std::io::ErrorKind;
    !matches!(
        e.kind(),
        ErrorKind::ConnectionReset
            | ErrorKind::ConnectionRefused
            | ErrorKind::ConnectionAborted
            | ErrorKind::WouldBlock
            | ErrorKind::Interrupted
            | ErrorKind::TimedOut
    )
}

/// 以 `SO_REUSEADDR`（及可用时 `SO_REUSEPORT`）创建并绑定一个 UDP 套接字。
///
/// # Arguments
///
/// * `bind_ip` - 绑定的本地 IPv4 地址（`0.0.0.0` 表示全部接口）。
/// * `port` - 绑定端口。
///
/// # Returns
///
/// 已绑定、非阻塞、可用于 tokio 的 [`UdpSocket`]。
///
/// # Errors
///
/// 套接字创建或绑定失败时返回 [`std::io::Error`]。
pub fn bind_reuse(bind_ip: Ipv4Addr, port: u16) -> std::io::Result<UdpSocket> {
    let sock = Socket::new(Domain::IPV4, Type::DGRAM, Some(S2Protocol::UDP))?;
    sock.set_reuse_address(true)?;
    #[cfg(unix)]
    sock.set_reuse_port(true)?;
    sock.set_nonblocking(true)?;
    sock.bind(&SocketAddr::from(SocketAddrV4::new(bind_ip, port)).into())?;
    UdpSocket::from_std(sock.into())
}

/// 在指定接口上加入一组 sACN Universe 的组播分组。
///
/// # Arguments
///
/// * `socket` - 已绑定 5568 端口的套接字。
/// * `iface` - 加入组播所用的本地接口 IPv4。
/// * `universes` - 需要接收的 Universe 列表。
///
/// # Errors
///
/// 加入任一组播分组失败时返回 [`std::io::Error`]。
pub fn join_sacn_multicast(
    socket: &UdpSocket,
    iface: Ipv4Addr,
    universes: &[u16],
) -> std::io::Result<()> {
    for &u in universes {
        socket.join_multicast_v4(sacn::multicast_addr(u), iface)?;
    }
    Ok(())
}

/// 启动一个 Art-Net 接收任务，将解析出的 ArtDmx 帧送入返回的通道。
///
/// # Arguments
///
/// * `bind_ip` - 绑定接口（`0.0.0.0` 为全部）。
/// * `tx` - 帧发送端。
///
/// # Returns
///
/// 后台任务句柄。
///
/// # Errors
///
/// 绑定失败时返回 [`std::io::Error`]。
pub fn spawn_artnet_receiver(
    bind_ip: Ipv4Addr,
    tx: mpsc::Sender<DmxFrame>,
    reply_tx: Option<mpsc::Sender<PollReplyInfo>>,
) -> std::io::Result<tokio::task::JoinHandle<()>> {
    let socket = bind_reuse(bind_ip, ARTNET_PORT)?;
    Ok(tokio::spawn(async move {
        let mut buf = vec![0u8; RECV_BUF];
        loop {
            let recv = socket.recv_from(&mut buf).await;
            // 紧随 recv 返回取时刻，避免解析与排队抖动混入录制时间轴
            let received_at = Instant::now();
            match recv {
                Ok((n, src)) => match artnet::parse(&buf[..n]) {
                    Some(ArtNetPacket::Dmx {
                        port_address,
                        sequence,
                        data,
                    }) => {
                        let frame = DmxFrame {
                            protocol: Protocol::ArtNet,
                            universe: port_address,
                            data: data.into(),
                            source: Some(src.ip()),
                            sequence,
                            received_at,
                        };
                        if tx.send(frame).await.is_err() {
                            break;
                        }
                    }
                    Some(ArtNetPacket::PollReply(info)) => {
                        if let Some(r) = &reply_tx {
                            let _ = r.send(info).await;
                        }
                    }
                    _ => {}
                },
                Err(e) => {
                    if is_fatal_recv_error(&e) {
                        tracing::warn!(error = %e, "Art-Net 接收致命错误，终止接收任务");
                        break;
                    }
                    tracing::debug!(error = %e, "Art-Net 接收瞬时错误，已忽略");
                }
            }
        }
    }))
}

/// 启动一个 sACN 接收任务（已加入指定 Universe 组播）。
///
/// # Arguments
///
/// * `bind_ip` - 绑定接口 IPv4。
/// * `universes` - 订阅的 Universe 列表。
/// * `tx` - 帧发送端。
///
/// # Returns
///
/// 后台任务句柄。
///
/// # Errors
///
/// 绑定或加入组播失败时返回 [`std::io::Error`]。
pub fn spawn_sacn_receiver(
    bind_ip: Ipv4Addr,
    universes: Vec<u16>,
    tx: mpsc::Sender<DmxFrame>,
) -> std::io::Result<tokio::task::JoinHandle<()>> {
    let socket = bind_reuse(Ipv4Addr::UNSPECIFIED, SACN_PORT)?;
    join_sacn_multicast(&socket, bind_ip, &universes)?;
    Ok(tokio::spawn(async move {
        let mut buf = vec![0u8; RECV_BUF];
        loop {
            let recv = socket.recv_from(&mut buf).await;
            let received_at = Instant::now();
            match recv {
                Ok((n, src)) => {
                    if let Some(d) = sacn::parse(&buf[..n]) {
                        let frame = DmxFrame {
                            protocol: Protocol::Sacn,
                            universe: d.universe,
                            data: d.data.into(),
                            source: Some(src.ip()),
                            sequence: d.sequence,
                            received_at,
                        };
                        if tx.send(frame).await.is_err() {
                            break;
                        }
                    }
                }
                Err(e) => {
                    if is_fatal_recv_error(&e) {
                        tracing::warn!(error = %e, "sACN 接收致命错误，终止接收任务");
                        break;
                    }
                    tracing::debug!(error = %e, "sACN 接收瞬时错误，已忽略");
                }
            }
        }
    }))
}

/// UDP 发送器：向目标地址发送 ArtDmx 或 sACN 数据包。
pub struct DmxSender {
    socket: UdpSocket,
    cid: [u8; 16],
}

impl DmxSender {
    /// 创建发送器（绑定任意本地端口，允许广播）。
    ///
    /// # Arguments
    ///
    /// * `cid` - 发送 sACN 时使用的 CID。
    ///
    /// # Returns
    ///
    /// 就绪的发送器。
    ///
    /// # Errors
    ///
    /// 绑定或设置广播失败时返回 [`std::io::Error`]。
    pub async fn new(cid: [u8; 16]) -> std::io::Result<Self> {
        let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).await?;
        socket.set_broadcast(true)?;
        Ok(Self { socket, cid })
    }

    /// 发送一帧 ArtDmx。
    ///
    /// # Arguments
    ///
    /// * `target` - 目标地址（含端口）。
    /// * `port_address` - 15 位 Port-Address。
    /// * `sequence` - 序列号。
    /// * `data` - 通道数据。
    ///
    /// # Errors
    ///
    /// 发送失败时返回 [`std::io::Error`]。
    pub async fn send_artnet(
        &self,
        target: SocketAddr,
        port_address: u16,
        sequence: u8,
        data: &[u8],
    ) -> std::io::Result<()> {
        let buf = artnet::build_dmx(port_address, sequence, data);
        self.socket.send_to(&buf, target).await?;
        Ok(())
    }

    /// 向全网广播一个 ArtPoll（触发节点回复 ArtPollReply 以供发现）。
    ///
    /// 仅发往受限广播地址 `255.255.255.255`；多网卡场景请改用
    /// [`DmxSender::send_poll_to`] 逐个子网定向广播。
    ///
    /// # Errors
    ///
    /// 发送失败时返回 [`std::io::Error`]。
    pub async fn broadcast_poll(&self) -> std::io::Result<()> {
        self.send_poll_to(Ipv4Addr::BROADCAST).await
    }

    /// 向指定 IPv4 地址（通常是某子网的定向广播地址）发送一个 ArtPoll。
    ///
    /// # Arguments
    ///
    /// * `target` - 目标 IPv4 地址，端口固定为 Art-Net 6454。
    ///
    /// # Errors
    ///
    /// 发送失败时返回 [`std::io::Error`]。
    pub async fn send_poll_to(&self, target: Ipv4Addr) -> std::io::Result<()> {
        let buf = artnet::build_poll();
        let addr = SocketAddr::new(IpAddr::V4(target), ARTNET_PORT);
        self.socket.send_to(&buf, addr).await?;
        Ok(())
    }

    /// 发送一帧 sACN（单播或组播，由 `target` 决定）。
    ///
    /// # Arguments
    ///
    /// * `target` - 目标地址；传 `None` 时发往该 Universe 的组播地址。
    /// * `universe` - Universe 编号。
    /// * `sequence` - 序列号。
    /// * `priority` - 优先级。
    /// * `data` - 通道数据。
    ///
    /// # Errors
    ///
    /// 发送失败时返回 [`std::io::Error`]。
    pub async fn send_sacn(
        &self,
        target: Option<SocketAddr>,
        universe: u16,
        sequence: u8,
        priority: u8,
        data: &[u8],
    ) -> std::io::Result<()> {
        let buf = sacn::build(universe, data, &self.cid, "Art-Net Studio", priority, sequence);
        let addr = target.unwrap_or_else(|| {
            SocketAddr::new(IpAddr::V4(sacn::multicast_addr(universe)), SACN_PORT)
        });
        self.socket.send_to(&buf, addr).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::is_fatal_recv_error;
    use std::io::{Error, ErrorKind};

    #[test]
    fn connection_reset_is_recoverable() {
        // Windows WSAECONNRESET：先前 send 收到 ICMP 不可达后 recv 返回，应可恢复
        assert!(!is_fatal_recv_error(&Error::from(ErrorKind::ConnectionReset)));
    }

    #[test]
    fn transient_kinds_are_recoverable() {
        for k in [
            ErrorKind::ConnectionRefused,
            ErrorKind::ConnectionAborted,
            ErrorKind::WouldBlock,
            ErrorKind::Interrupted,
            ErrorKind::TimedOut,
        ] {
            assert!(!is_fatal_recv_error(&Error::from(k)), "{k:?} 应为可恢复");
        }
    }

    #[test]
    fn addr_not_available_is_fatal() {
        // 绑定地址失效等无法继续的错误应终止接收任务
        assert!(is_fatal_recv_error(&Error::from(ErrorKind::AddrNotAvailable)));
    }
}

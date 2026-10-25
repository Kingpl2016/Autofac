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

/// 一次组播加入的结果汇总。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SacnJoinReport {
    /// 成功加入的（网卡, Universe）组数。
    pub joined: usize,
    /// 加入失败的组及原因（形如 `192.168.1.5 / U3: 错误信息`）。
    pub failed: Vec<String>,
}

impl SacnJoinReport {
    /// 尝试加入的总组数。
    #[must_use]
    pub fn attempted(&self) -> usize {
        self.joined + self.failed.len()
    }
}

/// 在若干网卡上逐个加入 sACN Universe 的组播分组。
///
/// 单个（网卡, Universe）加入失败不会中止其余：多网卡下回环、已断开的网卡，
/// 或系统对单套接字组播成员数的上限（如 Linux 默认 20）都可能导致个别失败。
///
/// # Arguments
///
/// * `socket` - 已绑定 sACN 端口的套接字。
/// * `ifaces` - 加入组播所用的本地接口 IPv4 列表。
/// * `universes` - 需要接收的 Universe 列表。
///
/// # Returns
///
/// 成功与失败的汇总，失败只记录 `warn` 日志。
pub fn join_sacn_multicast(
    socket: &UdpSocket,
    ifaces: &[Ipv4Addr],
    universes: &[u16],
) -> SacnJoinReport {
    let mut report = SacnJoinReport::default();
    for &iface in ifaces {
        for &u in universes {
            match socket.join_multicast_v4(sacn::multicast_addr(u), iface) {
                Ok(()) => report.joined += 1,
                Err(e) => {
                    let msg = format!("{iface} / U{u}: {e}");
                    tracing::warn!(error = %msg, "sACN 加入组播失败");
                    report.failed.push(msg);
                }
            }
        }
    }
    report
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

/// 运行中的 sACN 接收任务及其绑定结果。
#[derive(Debug)]
pub struct SacnReceiver {
    /// 后台任务句柄；`abort()` 会丢弃套接字并退出全部组播分组。
    pub handle: tokio::task::JoinHandle<()>,
    /// 实际绑定的本地端口（传入端口 0 时为系统分配的端口）。
    pub local_port: u16,
    /// 成功加入的（网卡, Universe）组数。
    pub joined: usize,
    /// 加入失败的组及原因。
    pub failed: Vec<String>,
}

/// 启动一个 sACN 接收任务。
///
/// 套接字绑定 `0.0.0.0:port`（绑定到具体网卡 IP 的套接字收不到组播），
/// 再对 `ifaces` 中每块网卡逐个加入 `universes` 的组播。因此网卡列表只决定
/// 组播订阅；发往本机的单播 sACN 从任何网卡进来都会被收到。
///
/// # Arguments
///
/// * `port` - 监听端口（标准为 5568）。
/// * `ifaces` - 加入组播的本地网卡 IPv4 列表。
/// * `universes` - 订阅的 Universe 列表。
/// * `tx` - 帧发送端。
///
/// # Returns
///
/// 接收任务句柄与加入结果。
///
/// # Errors
///
/// 绑定失败，或需要加入的组播分组全部失败时返回 [`std::io::Error`]。
pub fn spawn_sacn_receiver(
    port: u16,
    ifaces: &[Ipv4Addr],
    universes: &[u16],
    tx: mpsc::Sender<DmxFrame>,
) -> std::io::Result<SacnReceiver> {
    let socket = bind_reuse(Ipv4Addr::UNSPECIFIED, port)?;
    let local_port = socket.local_addr()?.port();
    let report = join_sacn_multicast(&socket, ifaces, universes);
    if report.attempted() > 0 && report.joined == 0 {
        return Err(std::io::Error::other(format!(
            "sACN 组播全部加入失败: {}",
            report.failed.join("; ")
        )));
    }
    let handle = tokio::spawn(async move {
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
    });
    Ok(SacnReceiver {
        handle,
        local_port,
        joined: report.joined,
        failed: report.failed,
    })
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
    use super::{bind_reuse, is_fatal_recv_error, join_sacn_multicast, spawn_sacn_receiver};
    use crate::frame::Protocol;
    use crate::sacn;
    use std::io::{Error, ErrorKind};
    use std::net::Ipv4Addr;
    use std::time::Duration;
    use tokio::sync::mpsc;

    #[tokio::test]
    async fn sacn_receiver_gets_unicast_on_custom_port() {
        let (tx, mut rx) = mpsc::channel(8);
        // 端口 0：由系统分配，避免与本机其它实例冲突；不订阅组播，仅验证单播接收
        let r = spawn_sacn_receiver(0, &[], &[], tx).expect("绑定应成功");
        assert_ne!(r.local_port, 0, "应返回系统分配的实际端口");
        assert_eq!((r.joined, r.failed.len()), (0, 0));

        let sender = tokio::net::UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let pkt = sacn::build(3, &[1, 2, 3], &[7u8; 16], "t", 100, 9);
        sender
            .send_to(&pkt, (Ipv4Addr::LOCALHOST, r.local_port))
            .await
            .unwrap();

        let frame = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("2 秒内应收到帧")
            .expect("通道未关闭");
        assert_eq!(frame.protocol, Protocol::Sacn);
        assert_eq!(frame.universe, 3);
        assert_eq!(&frame.data[..3], &[1, 2, 3]);
        r.handle.abort();
    }

    #[tokio::test]
    async fn join_failures_are_collected_not_fatal() {
        let sock = bind_reuse(Ipv4Addr::UNSPECIFIED, 0).unwrap();
        // 192.0.2.x 为文档保留网段，本机不可能有这块网卡，加入应失败但不能 panic
        let ifaces = [Ipv4Addr::new(192, 0, 2, 1), Ipv4Addr::new(192, 0, 2, 2)];
        let report = join_sacn_multicast(&sock, &ifaces, &[1, 2]);
        assert_eq!(report.attempted(), 4, "每个（网卡, Universe）都应被尝试");
        assert_eq!(report.joined + report.failed.len(), 4);
    }

    #[tokio::test]
    async fn all_joins_failing_is_an_error() {
        let (tx, _rx) = mpsc::channel(1);
        let res = spawn_sacn_receiver(0, &[Ipv4Addr::new(192, 0, 2, 1)], &[1], tx);
        // 平台若允许加入保留网段则不会失败，此时只要求句柄可用
        match res {
            Err(e) => assert!(e.to_string().contains("全部加入失败")),
            Ok(r) => r.handle.abort(),
        }
    }

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

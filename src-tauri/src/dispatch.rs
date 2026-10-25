//! 信号输出分发：把某个 Universe 的一帧数据按转发表（或指定目标）解析成发送任务并发出。
//!
//! 实时接收链路与录制回放共用本模块，保证两者的路由、偏移、延迟与发送行为一致。

use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use artnet_net::socket::DmxSender;
use artnet_net::Bytes;
use forwarding::{ForwardProtocol, ForwardingTable, RateLimiter, MIN_INTERVAL_MS_44HZ};
use serde::{Deserialize, Serialize};

use crate::util::lock;

/// 一次待发送任务。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForwardJob {
    /// 输出协议。
    pub protocol: ForwardProtocol,
    /// 目标 IP 字符串。
    pub target_ip: String,
    /// 目标端口。
    pub port: u16,
    /// 目标 Universe。
    pub target_universe: u16,
    /// 延迟（毫秒），0 为立即发送。
    pub delay_ms: u16,
    /// 通道数据（多目标共享引用计数缓冲，避免每目标深拷贝整帧）。
    pub data: Bytes,
}

/// 一条解析后的路由（`plan` 的中间表示，字段具名以替代易错的位置元组）。
struct Route {
    /// 限速键（目的地 id 或 `direct:ip:port`）。
    id: String,
    /// 输出协议。
    protocol: ForwardProtocol,
    /// 目标 IP 字符串。
    target_ip: String,
    /// 目标端口。
    port: u16,
    /// 目标 Universe。
    target_universe: u16,
    /// 延迟（毫秒）。
    delay_ms: u16,
}

/// 输出目标。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DispatchTarget {
    /// 走转发表（与实时信号相同的路由、偏移与延迟）。
    #[default]
    Forwarding,
    /// 直接发往指定地址，Universe 编号保持不变。
    #[serde(rename_all = "camelCase")]
    Direct {
        /// 目标 IP。
        ip: String,
        /// 输出协议。
        protocol: ForwardProtocol,
        /// 目标端口。
        port: u16,
    },
}

/// 输出分发器（可克隆，内部共享转发表 / 限速器 / 发送器）。
#[derive(Clone)]
pub struct Dispatcher {
    forwarding: Arc<Mutex<ForwardingTable>>,
    limiter: Arc<Mutex<RateLimiter>>,
    sender: Arc<tokio::sync::Mutex<Option<DmxSender>>>,
}

impl Dispatcher {
    /// 由运行时共享的组件构造。
    ///
    /// # Arguments
    ///
    /// * `forwarding` - 运行时共享的转发表。
    /// * `limiter` - 运行时共享的 44Hz 限速器。
    /// * `sender` - 运行时共享的 DMX 发送器；为 `None` 时发送会被静默忽略。
    ///
    /// # Returns
    ///
    /// 持有上述共享组件的 [`Dispatcher`]。
    #[must_use]
    pub fn new(
        forwarding: Arc<Mutex<ForwardingTable>>,
        limiter: Arc<Mutex<RateLimiter>>,
        sender: Arc<tokio::sync::Mutex<Option<DmxSender>>>,
    ) -> Self {
        Self {
            forwarding,
            limiter,
            sender,
        }
    }

    /// 清空限速状态（转发表变更后调用，避免已删除目的地的条目残留）。
    pub fn reset_rate_limits(&self) {
        lock(&self.limiter).clear();
    }

    /// 当前启用的转发目的地数量（回放走转发表时用于提示"没有可用目的地"）。
    ///
    /// # Returns
    ///
    /// 转发表中 `enabled` 为 `true` 的目的地个数；转发表锁中毒时返回 `0`。
    #[must_use]
    pub fn enabled_destinations(&self) -> usize {
        lock(&self.forwarding)
            .destinations
            .iter()
            .filter(|d| d.enabled)
            .count()
    }

    /// 为一帧数据解析发送任务。
    ///
    /// # Arguments
    ///
    /// * `universe` - 源 Universe。
    /// * `data` - 通道数据。
    /// * `now_ms` - 当前逻辑时间（毫秒），供限速使用。
    /// * `target` - 输出目标。
    /// * `rate_limited` - 是否应用 44Hz 限速。实时链路开启；回放的节奏由文件
    ///   时间轴决定，关闭以免丢帧。
    ///
    /// # Returns
    ///
    /// 需要发送的任务列表（可能为空）。
    #[must_use]
    pub fn plan(
        &self,
        universe: u16,
        data: &[u8],
        now_ms: u64,
        target: &DispatchTarget,
        rate_limited: bool,
    ) -> Vec<ForwardJob> {
        let routes: Vec<Route> = match target {
            DispatchTarget::Forwarding => {
                let table = lock(&self.forwarding);
                table
                    .routes_for(universe)
                    .into_iter()
                    .map(|(d, r)| Route {
                        id: d.id.clone(),
                        protocol: d.protocol,
                        target_ip: d.target_ip.clone(),
                        port: d.port,
                        target_universe: r.target_universe,
                        delay_ms: r.delay_ms,
                    })
                    .collect()
            }
            DispatchTarget::Direct { ip, protocol, port } => vec![Route {
                id: format!("direct:{ip}:{port}"),
                protocol: *protocol,
                target_ip: ip.clone(),
                port: *port,
                target_universe: universe,
                delay_ms: 0,
            }],
        };
        if routes.is_empty() {
            return Vec::new();
        }

        // 多目标共享同一份负载：Bytes clone 仅增减引用计数，避免每目标 to_vec 深拷贝。
        let payload = Bytes::copy_from_slice(data);
        let mut jobs = Vec::with_capacity(routes.len());
        let mut limiter = if rate_limited {
            Some(lock(&self.limiter))
        } else {
            None
        };
        for route in routes {
            let allowed = match limiter.as_mut() {
                Some(l) => l.allow(&route.id, route.target_universe, now_ms, MIN_INTERVAL_MS_44HZ),
                None => true,
            };
            if allowed {
                jobs.push(ForwardJob {
                    protocol: route.protocol,
                    target_ip: route.target_ip,
                    port: route.port,
                    target_universe: route.target_universe,
                    delay_ms: route.delay_ms,
                    data: payload.clone(),
                });
            }
        }
        jobs
    }

    /// 发送任务：延迟为 0 的立即发送，其余在独立任务里延迟后发送。
    ///
    /// # Arguments
    ///
    /// * `jobs` - 由 [`Dispatcher::plan`] 生成的发送任务列表。
    pub async fn send_jobs(&self, jobs: Vec<ForwardJob>) {
        for job in jobs {
            if job.delay_ms == 0 {
                send_one(&self.sender, &job).await;
            } else {
                let sender = self.sender.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(u64::from(job.delay_ms))).await;
                    send_one(&sender, &job).await;
                });
            }
        }
    }

    /// 解析并发送（`plan` + `send_jobs`）。仅测试便捷封装。
    ///
    /// # Arguments
    ///
    /// * `universe` - 源 Universe。
    /// * `data` - 通道数据。
    /// * `now_ms` - 当前逻辑时间（毫秒），供限速使用。
    /// * `target` - 输出目标。
    /// * `rate_limited` - 是否应用 44Hz 限速。
    #[cfg(test)]
    pub async fn dispatch(
        &self,
        universe: u16,
        data: &[u8],
        now_ms: u64,
        target: &DispatchTarget,
        rate_limited: bool,
    ) {
        let jobs = self.plan(universe, data, now_ms, target, rate_limited);
        self.send_jobs(jobs).await;
    }
}

/// 执行一次发送（Art-Net 或 sACN 单播到目标）。目标 IP 非法或发送器未就绪时静默忽略。
async fn send_one(sender: &Arc<tokio::sync::Mutex<Option<DmxSender>>>, job: &ForwardJob) {
    let Ok(ip) = job.target_ip.parse::<IpAddr>() else {
        return;
    };
    let addr = SocketAddr::new(ip, job.port);
    let guard = sender.lock().await;
    let Some(s) = guard.as_ref() else { return };
    match job.protocol {
        ForwardProtocol::ArtNet => {
            let _ = s.send_artnet(addr, job.target_universe, 0, &job.data).await;
        }
        ForwardProtocol::Sacn => {
            let _ = s
                .send_sacn(Some(addr), job.target_universe, 0, 100, &job.data)
                .await;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use artnet_net::artnet::{self, ArtNetPacket};
    use artnet_net::socket::DmxSender;
    use forwarding::{
        ForwardDestination, ForwardMode, ForwardProtocol, ForwardingTable, OverrideAction,
        RateLimiter, UniverseOverride,
    };
    use tokio::net::UdpSocket;

    use super::{DispatchTarget, Dispatcher};

    fn dest(id: &str, port: u16, mode: ForwardMode) -> ForwardDestination {
        ForwardDestination {
            id: id.into(),
            name: id.into(),
            target_ip: "127.0.0.1".into(),
            protocol: ForwardProtocol::ArtNet,
            port,
            mode,
            universe_offset: 0,
            default_delay_ms: 0,
            description: String::new(),
            enabled: true,
            overrides: Vec::new(),
        }
    }

    fn dispatcher(table: ForwardingTable) -> Dispatcher {
        Dispatcher::new(
            Arc::new(Mutex::new(table)),
            Arc::new(Mutex::new(RateLimiter::new())),
            Arc::new(tokio::sync::Mutex::new(None)),
        )
    }

    #[test]
    fn plan_applies_offset_override_and_delay() {
        let mut a = dest("a", 6454, ForwardMode::All);
        a.universe_offset = 100;
        a.default_delay_ms = 50;
        let mut b = dest("b", 6455, ForwardMode::Selected);
        b.overrides.push(UniverseOverride {
            source_universe: 3,
            action: OverrideAction::Forward,
            target_universe: Some(30),
            delay_ms: Some(7),
        });
        let d = dispatcher(ForwardingTable {
            destinations: vec![a, b],
        });

        let jobs = d.plan(3, &[1, 2, 3], 0, &DispatchTarget::Forwarding, true);
        assert_eq!(jobs.len(), 2);
        assert_eq!((jobs[0].target_universe, jobs[0].delay_ms, jobs[0].port), (103, 50, 6454));
        assert_eq!((jobs[1].target_universe, jobs[1].delay_ms, jobs[1].port), (30, 7, 6455));
        assert_eq!(jobs[0].data, vec![1, 2, 3]);

        // Universe 4 只命中 All 模式的目的地 a
        let jobs = d.plan(4, &[9], 1000, &DispatchTarget::Forwarding, true);
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].target_universe, 104);
    }

    #[test]
    fn plan_rate_limits_live_traffic_but_not_playback() {
        let d = dispatcher(ForwardingTable {
            destinations: vec![dest("a", 6454, ForwardMode::All)],
        });
        // 实时：同一目的地同一 Universe 10ms 内的第二帧被限速丢弃
        assert_eq!(d.plan(1, &[1], 0, &DispatchTarget::Forwarding, true).len(), 1);
        assert_eq!(d.plan(1, &[2], 10, &DispatchTarget::Forwarding, true).len(), 0);
        assert_eq!(d.plan(1, &[3], 30, &DispatchTarget::Forwarding, true).len(), 1);
        // 回放：不限速，帧节奏由文件时间轴决定
        assert_eq!(d.plan(1, &[4], 31, &DispatchTarget::Forwarding, false).len(), 1);
        assert_eq!(d.plan(1, &[5], 32, &DispatchTarget::Forwarding, false).len(), 1);
    }

    #[test]
    fn disabled_and_unmatched_destinations_produce_no_jobs() {
        let mut off = dest("off", 6454, ForwardMode::All);
        off.enabled = false;
        let d = dispatcher(ForwardingTable {
            destinations: vec![off, dest("sel", 6454, ForwardMode::Selected)],
        });
        assert!(d.plan(1, &[1], 0, &DispatchTarget::Forwarding, false).is_empty());
        assert_eq!(d.enabled_destinations(), 1);
    }

    #[test]
    fn direct_target_keeps_universe_and_ignores_forwarding_table() {
        let d = dispatcher(ForwardingTable::default());
        let target = DispatchTarget::Direct {
            ip: "192.168.1.50".into(),
            protocol: ForwardProtocol::Sacn,
            port: 5568,
        };
        let jobs = d.plan(7, &[1, 2], 0, &target, false);
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].target_ip, "192.168.1.50");
        assert_eq!((jobs[0].target_universe, jobs[0].delay_ms, jobs[0].port), (7, 0, 5568));
        assert_eq!(jobs[0].protocol, ForwardProtocol::Sacn);
    }

    #[test]
    fn target_serde_uses_tagged_camel_case() {
        let t = DispatchTarget::Direct {
            ip: "1.2.3.4".into(),
            protocol: ForwardProtocol::ArtNet,
            port: 6454,
        };
        let json = serde_json::to_string(&t).unwrap();
        assert_eq!(json, r#"{"kind":"direct","ip":"1.2.3.4","protocol":"artNet","port":6454}"#);
        assert_eq!(serde_json::from_str::<DispatchTarget>(&json).unwrap(), t);
        assert_eq!(
            serde_json::from_str::<DispatchTarget>(r#"{"kind":"forwarding"}"#).unwrap(),
            DispatchTarget::Forwarding
        );
    }

    /// 端到端：经转发表（偏移 100）发出的 Art-Net 包被本机 UDP 套接字收到，Universe 与数据正确。
    #[tokio::test]
    async fn dispatch_delivers_artdmx_over_udp() {
        let rx = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let port = rx.local_addr().unwrap().port();

        let mut a = dest("a", port, ForwardMode::All);
        a.universe_offset = 100;
        let d = Dispatcher::new(
            Arc::new(Mutex::new(ForwardingTable {
                destinations: vec![a],
            })),
            Arc::new(Mutex::new(RateLimiter::new())),
            Arc::new(tokio::sync::Mutex::new(Some(
                DmxSender::new([0u8; 16]).await.unwrap(),
            ))),
        );
        d.dispatch(5, &[10, 20, 30, 40], 0, &DispatchTarget::Forwarding, true).await;

        let mut buf = [0u8; 2048];
        let (n, _) = tokio::time::timeout(Duration::from_secs(2), rx.recv_from(&mut buf))
            .await
            .expect("2 秒内应收到包")
            .unwrap();
        match artnet::parse(&buf[..n]) {
            Some(ArtNetPacket::Dmx { port_address, data, .. }) => {
                assert_eq!(port_address, 105);
                assert_eq!(&data[..4], &[10, 20, 30, 40]);
            }
            other => panic!("期望 ArtDmx，实际 {other:?}"),
        }
    }

    /// 延迟 > 0 的任务会在延迟之后才到达。
    #[tokio::test]
    async fn delayed_jobs_arrive_after_the_delay() {
        let rx = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let port = rx.local_addr().unwrap().port();
        let mut a = dest("a", port, ForwardMode::All);
        a.default_delay_ms = 120;
        let d = Dispatcher::new(
            Arc::new(Mutex::new(ForwardingTable {
                destinations: vec![a],
            })),
            Arc::new(Mutex::new(RateLimiter::new())),
            Arc::new(tokio::sync::Mutex::new(Some(
                DmxSender::new([0u8; 16]).await.unwrap(),
            ))),
        );
        let start = std::time::Instant::now();
        d.dispatch(1, &[1], 0, &DispatchTarget::Forwarding, true).await;
        let mut buf = [0u8; 2048];
        tokio::time::timeout(Duration::from_secs(2), rx.recv_from(&mut buf))
            .await
            .expect("应收到包")
            .unwrap();
        assert!(start.elapsed() >= Duration::from_millis(100), "{:?}", start.elapsed());
    }
}

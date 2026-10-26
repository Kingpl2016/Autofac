//! 回放输出：回放线程经有界队列把 [`Emission`] 交给 tokio 输出任务，由它解析路由并发送。
//!
//! 回放线程只负责计时，不做任何网络 IO；输出任务复用发送任务缓冲，用
//! [`Dispatcher::plan_into`] + [`Dispatcher::send_batch`] 发送（回放不限速）。
//!
//! 队列满时的策略（见 [`OutputQueue::submit`]）：
//!
//! - **全量状态**（含 seek 补发或保活的输出）：`blocking_send`，保证送达；
//! - **普通到期帧**：`try_send`，满了就丢弃并计数（节流告警），并标记"需要重新同步"；
//!   之后的第一次普通输出改发当前完整状态（[`player::Player::full_state`]），
//!   覆盖被丢弃的增量，输出端不会停留在过期数据上。

use std::sync::Arc;
use std::time::{Duration, Instant};

use player::{Emission, EmissionKind, UniverseData};
use tokio::sync::mpsc::{self, error::TrySendError};

use crate::dispatch::{DispatchTarget, Dispatcher};

/// 输出队列容量（消息数，每条消息是一次 `poll` / 命令的全部输出）。
pub(crate) const OUTPUT_QUEUE: usize = 64;

/// 丢帧告警的最小间隔。
const DROP_WARN_EVERY: Duration = Duration::from_secs(5);

/// 一条输出消息：一次 `poll` / 命令产生的全部输出及其目标。
#[derive(Debug)]
pub(crate) struct OutputMsg {
    /// 输出目标（随消息携带：切换目标后之前排队的输出仍发往旧目标）。
    pub(crate) target: Arc<DispatchTarget>,
    /// 输出内容。
    pub(crate) emissions: Vec<Emission>,
}

/// 回放线程一侧的输出队列。
#[derive(Debug)]
pub(crate) struct OutputQueue {
    /// 队列发送端；丢弃即关闭队列，输出任务随之结束。
    tx: mpsc::Sender<OutputMsg>,
    /// 累计丢弃的消息数。
    dropped: u64,
    /// 丢过帧、尚未补发完整状态。
    resync: bool,
    /// 上次丢帧告警的时刻。
    last_warn: Option<Instant>,
}

/// 创建输出队列。
///
/// # Arguments
///
/// * `capacity` - 队列容量（消息数，至少为 `1`）。
///
/// # Returns
///
/// `(回放线程一侧的队列, 输出任务一侧的接收端)`。
pub(crate) fn queue(capacity: usize) -> (OutputQueue, mpsc::Receiver<OutputMsg>) {
    let (tx, rx) = mpsc::channel(capacity.max(1));
    (
        OutputQueue {
            tx,
            dropped: 0,
            resync: false,
            last_warn: None,
        },
        rx,
    )
}

impl OutputQueue {
    /// 提交一次输出（在回放线程上调用，**不得**位于 tokio 运行时上下文中：全量状态会阻塞等待队列空位）。
    ///
    /// # Arguments
    ///
    /// * `target` - 输出目标。
    /// * `emissions` - 本次输出；为空时什么也不做。
    /// * `full_state` - 取当前完整状态（丢帧后补发时才调用）。
    pub(crate) fn submit(
        &mut self,
        target: &Arc<DispatchTarget>,
        emissions: Vec<Emission>,
        full_state: impl FnOnce() -> Vec<UniverseData>,
    ) {
        if emissions.is_empty() {
            return;
        }
        let carries_full_state = emissions
            .iter()
            .any(|e| matches!(e.kind, EmissionKind::Seek | EmissionKind::Keepalive));
        if carries_full_state {
            // 全量状态保证送达；它本身就是完整状态，也就完成了重新同步。
            // 只有输出任务已结束（运行时关闭）时才会失败，此时无处可发。
            self.resync = false;
            let _ = self.tx.blocking_send(OutputMsg {
                target: target.clone(),
                emissions,
            });
            return;
        }
        let emissions = if self.resync {
            vec![Emission {
                kind: EmissionKind::Keepalive,
                universes: full_state(),
            }]
        } else {
            emissions
        };
        match self.tx.try_send(OutputMsg {
            target: target.clone(),
            emissions,
        }) {
            Ok(()) => self.resync = false,
            Err(TrySendError::Full(_)) => {
                self.dropped += 1;
                self.resync = true;
                let now = Instant::now();
                if self
                    .last_warn
                    .is_none_or(|t| now.saturating_duration_since(t) >= DROP_WARN_EVERY)
                {
                    self.last_warn = Some(now);
                    tracing::warn!(
                        dropped = self.dropped,
                        "回放输出队列已满，丢弃到期帧（之后补发完整状态）"
                    );
                }
            }
            Err(TrySendError::Closed(_)) => {}
        }
    }

    /// 累计丢弃的消息数。
    ///
    /// # Returns
    ///
    /// 自创建以来因队列满被丢弃的普通输出条数。
    pub(crate) fn dropped(&self) -> u64 {
        self.dropped
    }
}

/// 输出任务：逐条取出输出消息，解析路由并发送；队列关闭（回放线程退出）且取空后结束。
///
/// # Arguments
///
/// * `dispatcher` - 输出分发器。
/// * `started_at` - 运行时起点（换算逻辑毫秒）。
/// * `rx` - 输出队列接收端。
pub(crate) async fn run_output(
    dispatcher: Dispatcher,
    started_at: Instant,
    mut rx: mpsc::Receiver<OutputMsg>,
) {
    let mut jobs = Vec::new();
    while let Some(msg) = rx.recv().await {
        let now_ms = started_at.elapsed().as_millis() as u64;
        for em in msg.emissions {
            for u in em.universes {
                dispatcher.plan_into(u.universe, u.data, now_ms, &msg.target, false, &mut jobs);
            }
        }
        dispatcher.send_batch(&mut jobs).await;
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use bytes::Bytes;
    use player::{Emission, EmissionKind, UniverseData};

    use super::{queue, OutputMsg};
    use crate::dispatch::DispatchTarget;

    fn em(kind: EmissionKind, universe: u16, v: u8) -> Vec<Emission> {
        vec![Emission {
            kind,
            universes: vec![UniverseData {
                universe,
                data: Bytes::from(vec![v]),
            }],
        }]
    }

    /// 消息摘要：`[(Universe, 首字节)]`。
    fn summary(m: &OutputMsg) -> Vec<(u16, u8)> {
        m.emissions
            .iter()
            .flat_map(|e| e.universes.iter().map(|u| (u.universe, u.data[0])))
            .collect()
    }

    #[test]
    fn full_queue_drops_changes_then_resyncs_with_the_full_state() {
        let (mut q, mut rx) = queue(2);
        let target = Arc::new(DispatchTarget::Forwarding);
        let state = || {
            vec![
                UniverseData {
                    universe: 1,
                    data: Bytes::from(vec![99]),
                },
                UniverseData {
                    universe: 2,
                    data: Bytes::from(vec![98]),
                },
            ]
        };
        q.submit(&target, Vec::new(), || unreachable!("空输出不应取完整状态"));
        q.submit(&target, em(EmissionKind::Change, 1, 1), || unreachable!());
        q.submit(&target, em(EmissionKind::Change, 1, 2), || unreachable!());
        // 队列已满：丢弃并计数
        q.submit(&target, em(EmissionKind::Change, 1, 3), || unreachable!());
        q.submit(&target, em(EmissionKind::Change, 2, 4), state);
        assert_eq!(q.dropped(), 2);

        assert_eq!(summary(&rx.try_recv().unwrap()), vec![(1, 1)]);
        assert_eq!(summary(&rx.try_recv().unwrap()), vec![(1, 2)]);
        // 有空位后的第一次普通输出改发完整状态
        q.submit(&target, em(EmissionKind::Change, 1, 5), state);
        assert_eq!(summary(&rx.try_recv().unwrap()), vec![(1, 99), (2, 98)]);
        // 同步之后恢复增量
        q.submit(&target, em(EmissionKind::Change, 1, 6), || unreachable!());
        assert_eq!(summary(&rx.try_recv().unwrap()), vec![(1, 6)]);
    }

    #[test]
    fn full_state_emissions_are_always_delivered_and_clear_resync() {
        let (mut q, mut rx) = queue(1);
        let target = Arc::new(DispatchTarget::Forwarding);
        q.submit(&target, em(EmissionKind::Change, 1, 1), || unreachable!());
        q.submit(&target, em(EmissionKind::Change, 1, 2), || unreachable!());
        assert_eq!(q.dropped(), 1);

        // seek 输出：阻塞等待空位（这里由另一个线程腾出），保证送达
        let drain = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(50));
            let first = rx.blocking_recv().unwrap();
            (first, rx)
        });
        q.submit(&target, em(EmissionKind::Seek, 1, 7), || unreachable!());
        let (first, mut rx) = drain.join().unwrap();
        assert_eq!(summary(&first), vec![(1, 1)]);
        let seek = rx.try_recv().unwrap();
        assert_eq!(
            (seek.emissions[0].kind, summary(&seek)),
            (EmissionKind::Seek, vec![(1, 7)])
        );

        // seek 是完整状态：不再需要补发
        q.submit(&target, em(EmissionKind::Change, 1, 8), || unreachable!());
        assert_eq!(summary(&rx.try_recv().unwrap()), vec![(1, 8)]);
        // 保活同样走保证送达
        q.submit(
            &target,
            em(EmissionKind::Keepalive, 1, 9),
            || unreachable!(),
        );
        assert_eq!(
            rx.try_recv().unwrap().emissions[0].kind,
            EmissionKind::Keepalive
        );
        // 丢弃发送端即关闭队列：输出任务据此结束
        drop(q);
        assert!(rx.blocking_recv().is_none());
    }
}

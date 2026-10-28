//! 延迟发送队列：一个常驻 worker 按到期时刻发送 `delay_ms > 0` 的任务。
//!
//! 此前每个延迟包 `tokio::spawn` 一个任务再 `sleep`，256 Universe × 44Hz 下每秒上万次
//! 任务创建与定时器注册。现在所有延迟任务经 `mpsc` 交给同一个 worker：它用
//! [`BinaryHeap`] 按 `(到期时刻, 递增序号)` 排序，`sleep_until` 等待最早到期者，
//! 同一到期时刻按提交顺序发送。
//!
//! worker 在第一次需要时于当前 tokio 运行时内惰性启动（分发器可能在运行时之外构造，
//! 例如基准测试）；所在运行时关闭导致 worker 退出后，下一次提交会自动重启。
//! 所有分发器句柄都销毁后，worker 发完已排队的任务再退出。

use std::cmp::{Ordering as CmpOrdering, Reverse};
use std::collections::BinaryHeap;
use std::time::Duration;

use parking_lot::Mutex;

use tokio::sync::mpsc::{self, error::TryRecvError, UnboundedReceiver, UnboundedSender};
use tokio::time::Instant;

use crate::dispatch::{send_one, ForwardJob, SendCtx};
use crate::util::lock;

/// 提交给 worker 的延迟任务。
pub(crate) struct Delayed {
    /// 到期时刻。
    due: Instant,
    /// 待发送任务。
    job: ForwardJob,
}

/// 堆中的排队项：按 `(due, seq)` 升序出堆。
struct Queued {
    due: Instant,
    seq: u64,
    job: ForwardJob,
}

impl PartialEq for Queued {
    fn eq(&self, other: &Self) -> bool {
        self.due == other.due && self.seq == other.seq
    }
}

impl Eq for Queued {}

impl PartialOrd for Queued {
    fn partial_cmp(&self, other: &Self) -> Option<CmpOrdering> {
        Some(self.cmp(other))
    }
}

impl Ord for Queued {
    fn cmp(&self, other: &Self) -> CmpOrdering {
        (self.due, self.seq).cmp(&(other.due, other.seq))
    }
}

/// 延迟队列句柄（惰性启动 worker）。
#[derive(Default)]
pub(crate) struct DelayQueue {
    tx: Mutex<Option<UnboundedSender<Delayed>>>,
}

impl DelayQueue {
    /// 取得提交通道；worker 尚未启动或已退出时（重新）启动。
    ///
    /// 有当前 tokio 运行时则在其上启动，否则落到 Tauri 的全局异步运行时。
    pub(crate) fn sender(&self, ctx: &SendCtx) -> UnboundedSender<Delayed> {
        let mut slot = lock(&self.tx);
        if let Some(tx) = slot.as_ref().filter(|tx| !tx.is_closed()) {
            return tx.clone();
        }
        let (tx, rx) = mpsc::unbounded_channel();
        let worker = run_worker(rx, ctx.clone());
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(worker);
        } else {
            tauri::async_runtime::spawn(worker);
        }
        *slot = Some(tx.clone());
        tx
    }

    /// 提交一个延迟任务（到期时刻从现在起算）。
    ///
    /// `tx` 为本批次缓存的提交通道；为 `None` 或 worker 已退出时取得新的通道。
    pub(crate) fn submit(
        &self,
        ctx: &SendCtx,
        tx: &mut Option<UnboundedSender<Delayed>>,
        job: ForwardJob,
    ) {
        let item = Delayed {
            due: Instant::now() + Duration::from_millis(u64::from(job.delay_ms)),
            job,
        };
        let sender = tx.get_or_insert_with(|| self.sender(ctx));
        if let Err(mpsc::error::SendError(item)) = sender.send(item) {
            // worker 随其运行时一起退出了：重启后重试一次
            let fresh = self.sender(ctx);
            let _ = fresh.send(item);
            *tx = Some(fresh);
        }
    }
}

/// worker 主循环。
async fn run_worker(mut rx: UnboundedReceiver<Delayed>, ctx: SendCtx) {
    let mut heap: BinaryHeap<Reverse<Queued>> = BinaryHeap::new();
    let mut seq: u64 = 0;
    let mut open = true;
    let mut push = |heap: &mut BinaryHeap<Reverse<Queued>>, d: Delayed| {
        seq += 1;
        heap.push(Reverse(Queued {
            due: d.due,
            seq,
            job: d.job,
        }));
    };
    loop {
        // 先把已到达的新任务全部收进堆，保证同一到期时刻按提交顺序出堆
        while open {
            match rx.try_recv() {
                Ok(d) => push(&mut heap, d),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => open = false,
            }
        }
        // 发送所有已到期者
        let now = Instant::now();
        if heap.peek().is_some_and(|q| q.0.due <= now) {
            let sender = ctx.sender.load_full();
            while heap.peek().is_some_and(|q| q.0.due <= now) {
                let Some(Reverse(q)) = heap.pop() else { break };
                send_one(sender.as_deref(), &ctx, &q.job).await;
            }
        }
        match (heap.peek().map(|q| q.0.due), open) {
            (None, false) => return,
            (None, true) => match rx.recv().await {
                Some(d) => push(&mut heap, d),
                None => open = false,
            },
            (Some(due), true) => {
                tokio::select! {
                    biased;
                    msg = rx.recv() => match msg {
                        Some(d) => push(&mut heap, d),
                        None => open = false,
                    },
                    () = tokio::time::sleep_until(due) => {}
                }
            }
            (Some(due), false) => tokio::time::sleep_until(due).await,
        }
    }
}

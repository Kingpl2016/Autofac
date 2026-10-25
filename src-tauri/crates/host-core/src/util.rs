//! host-core 内部共享工具。

use std::sync::{Mutex, MutexGuard, PoisonError};

/// 获取标准库互斥锁，中毒时恢复内部值而非 panic。
///
/// DMX 实时链路（接收/合并/转发/录制/回放）不能因某线程持锁期间 panic 就整体瘫痪，
/// 故一律在锁中毒后恢复 [`PoisonError::into_inner`] 继续使用。
pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

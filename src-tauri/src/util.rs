//! 宿主层共享工具。

use std::sync::{Mutex, MutexGuard, PoisonError};

/// 获取标准库互斥锁，中毒时恢复内部值而非 panic。
///
/// 全工程统一的锁获取策略：DMX 实时链路（接收/合并/转发/录制/回放）不能因某个
/// 线程在持锁期间 panic 就整体瘫痪，故一律在锁中毒后恢复 [`PoisonError::into_inner`]
/// 继续使用受保护数据。受保护结构本身对"部分更新"是健壮的，恢复后继续运行优于直接失败。
///
/// # Arguments
///
/// * `m` - 目标互斥锁。
///
/// # Returns
///
/// 锁守卫（中毒也返回）。
pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

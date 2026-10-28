//! host-core 内部共享工具。

use parking_lot::{Mutex, MutexGuard};

/// 获取互斥锁的守卫。
///
/// 全项目使用 `parking_lot::Mutex`：它不会毒化，持锁线程 panic 后其它线程仍能正常取用——
/// 正合 DMX 实时链路（接收/合并/转发/录制/回放）不能因某线程 panic 就整体瘫痪的语义。
pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock()
}

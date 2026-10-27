//! 录制活动时间线：按时间分桶 × Universe 统计变化强度与电平（只在内存里，不写入 `.artrec`）。
//!
//! 录制线程每写出一帧调用一次 [`ActivityTimeline::observe`]，把合并后的快照与上一份快照对比，
//! 累计每个桶内的变化通道数与最大电平；界面据此画出实时推进的“录制头时间线”。
//!
//! - 桶数上限 [`MAX_BUCKETS`]，初始桶宽 [`INITIAL_BUCKET_US`]。时间超出上限时相邻两桶合并
//!   （取最大值，单帧尖峰不会被抹掉），桶宽翻倍，`generation` 加一，内存因此有固定上界。
//! - 变化强度按固定对数刻度换成 0~255（实时数据无法事后归一化），见 [`scale_change`]。
//! - 静止时段没有新帧：[`ActivityTimeline::advance_to`] 只把时间轴延长到当前时刻，新桶的电平沿用
//!   最近一次快照（灯仍然亮着），变化强度为 0。
//! - 增量导出 [`ActivityTimeline::take_delta`] 只带上次导出之后被改动过的桶；合并后从 0 开始全量导出。

use serde::Serialize;

/// 桶数上限。
pub const MAX_BUCKETS: usize = 512;
/// 初始桶宽（微秒）。
pub const INITIAL_BUCKET_US: u64 = 250_000;
/// 变化强度对数刻度的系数：`round(CHANGE_SCALE * log2(1 + n))`，约 1600 个变化通道饱和到 255。
const CHANGE_SCALE: f64 = 24.0;

/// 把桶内累计的变化通道数换算为 0~255 的强度。
///
/// # Arguments
///
/// * `n` - 桶内累计的变化通道数（同一通道在多帧里变化按多次计）。
///
/// # Returns
///
/// `min(255, round(24 * log2(1 + n)))`；`n = 0` 时为 0，`n >= 1` 时至少为 24。
#[must_use]
#[allow(clippy::cast_sign_loss)] // 结果恒为非负
pub fn scale_change(n: u32) -> u8 {
    if n == 0 {
        return 0;
    }
    let v = (CHANGE_SCALE * f64::from(n).ln_1p() / std::f64::consts::LN_2).round();
    v.min(255.0) as u8
}

/// 一次导出的活动数据（增量或全量）。行数据为原始字节，宿主层再按需编码。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityDelta {
    /// 桶布局代次：每次合并桶加一。前端代次不一致且 `from != 0` 时应拉取全量。
    pub generation: u32,
    /// 当前桶宽（微秒）。
    pub bucket_us: u64,
    /// 时间线当前的总桶数。
    pub len: usize,
    /// 本次数据覆盖的第一个桶下标（行数据的第 0 个元素对应该桶）。
    pub from: usize,
    /// 各行对应的 Universe 编号（与录制的 Universe 集合同序）。
    pub universes: Vec<u16>,
    /// 变化强度：`change[行][i]` 对应桶 `from + i`，0~255。
    pub change: Vec<Vec<u8>>,
    /// 最大电平：`level[行][i]` 对应桶 `from + i`，0~255。
    pub level: Vec<Vec<u8>>,
    /// 各分段在会话时间轴上的起点（微秒，升序；第一段为 0）。
    pub part_starts_us: Vec<u64>,
}

/// 录制活动时间线。
#[derive(Debug, Clone)]
pub struct ActivityTimeline {
    universes: Vec<u16>,
    bucket_us: u64,
    generation: u32,
    len: usize,
    /// 每行每桶累计的变化通道数（未刻度）。
    change: Vec<Vec<u32>>,
    /// 每行每桶的最大电平。
    level: Vec<Vec<u8>>,
    /// 上一份快照（与 `universes` 同序）；尚未观察过时为空。
    prev: Vec<Vec<u8>>,
    /// 最近一次快照里每行的最大电平，用于填充静止时段的新桶。
    last_level: Vec<u8>,
    part_starts_us: Vec<u64>,
    /// 自上次 [`ActivityTimeline::take_delta`] 以来被改动过的最小桶下标；`None` 表示没有改动。
    dirty_from: Option<usize>,
}

impl ActivityTimeline {
    /// 创建空时间线。
    ///
    /// # Arguments
    ///
    /// * `universes` - 录制的 Universe 集合（行顺序与录制快照一致）。
    ///
    /// # Returns
    ///
    /// 长度为 0、桶宽为 [`INITIAL_BUCKET_US`]、第一段起点为 0 的时间线。
    #[must_use]
    pub fn new(universes: Vec<u16>) -> Self {
        let rows = universes.len();
        Self {
            universes,
            bucket_us: INITIAL_BUCKET_US,
            generation: 0,
            len: 0,
            change: vec![Vec::with_capacity(MAX_BUCKETS); rows],
            level: vec![Vec::with_capacity(MAX_BUCKETS); rows],
            prev: Vec::new(),
            last_level: vec![0; rows],
            part_starts_us: vec![0],
            dirty_from: None,
        }
    }

    /// 复位为新的录制会话（复用已分配的缓冲）。
    ///
    /// # Arguments
    ///
    /// * `universes` - 新会话的 Universe 集合。
    pub fn reset(&mut self, universes: Vec<u16>) {
        *self = Self::new(universes);
    }

    /// 当前桶宽（微秒）。
    ///
    /// # Returns
    ///
    /// 每个桶覆盖的时长；初始为 [`INITIAL_BUCKET_US`]，每次合并翻倍。
    #[must_use]
    pub fn bucket_us(&self) -> u64 {
        self.bucket_us
    }

    /// 当前总桶数。
    ///
    /// # Returns
    ///
    /// 已覆盖到的桶数，不超过 [`MAX_BUCKETS`]。
    #[must_use]
    pub fn len(&self) -> usize {
        self.len
    }

    /// 时间线是否为空（尚未覆盖任何时间）。
    ///
    /// # Returns
    ///
    /// 总桶数为 0 时为 `true`。
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// 记录一个新分段的起点。
    ///
    /// # Arguments
    ///
    /// * `start_us` - 新分段在会话时间轴上的起点（微秒）；不大于上一个起点时忽略。
    pub fn mark_part(&mut self, start_us: u64) {
        if self.part_starts_us.last().is_some_and(|&l| start_us > l) {
            self.part_starts_us.push(start_us);
        }
    }

    /// 两两合并相邻桶，桶宽翻倍、代次加一，并把全部桶标为已改动。
    fn compact(&mut self) {
        for row in &mut self.change {
            let merged: Vec<u32> = row
                .chunks(2)
                .map(|p| p.iter().copied().max().unwrap_or(0))
                .collect();
            *row = merged;
        }
        for row in &mut self.level {
            let merged: Vec<u8> = row
                .chunks(2)
                .map(|p| p.iter().copied().max().unwrap_or(0))
                .collect();
            *row = merged;
        }
        self.len = self.len.div_ceil(2);
        self.bucket_us *= 2;
        self.generation = self.generation.wrapping_add(1);
        self.dirty_from = Some(0);
    }

    /// 标记桶 `i` 已改动。
    fn touch(&mut self, i: usize) {
        self.dirty_from = Some(self.dirty_from.map_or(i, |d| d.min(i)));
    }

    /// 保证覆盖到时刻 `t_us` 所在的桶，必要时合并；返回该桶下标。
    fn ensure(&mut self, t_us: u64) -> usize {
        let mut idx = (t_us / self.bucket_us) as usize;
        while idx >= MAX_BUCKETS {
            self.compact();
            idx = (t_us / self.bucket_us) as usize;
        }
        if idx >= self.len {
            let first_new = self.len;
            for (r, row) in self.change.iter_mut().enumerate() {
                row.resize(idx + 1, 0);
                self.level[r].resize(idx + 1, self.last_level[r]);
            }
            self.len = idx + 1;
            self.touch(first_new);
        }
        idx
    }

    /// 把时间轴延长到 `t_us`（静止时段不产生新帧时调用）。
    ///
    /// # Arguments
    ///
    /// * `t_us` - 会话时间（微秒）。新桶的电平沿用最近一次快照，变化强度为 0。
    pub fn advance_to(&mut self, t_us: u64) {
        self.ensure(t_us);
    }

    /// 观察一份写出的合并快照。
    ///
    /// # Arguments
    ///
    /// * `t_us` - 该帧在会话时间轴上的时刻（微秒）。
    /// * `snaps` - 各路合并后的 DMX 数据，与构造时的 Universe 集合同序；行数不符时多余的忽略、
    ///   缺少的视为没有数据。
    pub fn observe(&mut self, t_us: u64, snaps: &[Vec<u8>]) {
        if self.universes.is_empty() {
            return;
        }
        let idx = self.ensure(t_us);
        if self.prev.len() != self.universes.len() {
            self.prev = vec![Vec::new(); self.universes.len()];
        }
        for (r, snap) in snaps.iter().enumerate().take(self.universes.len()) {
            let prev = &self.prev[r];
            let common = prev.len().min(snap.len());
            let mut changed = prev[..common]
                .iter()
                .zip(&snap[..common])
                .filter(|(a, b)| a != b)
                .count();
            // 长度变化的部分：新出现的非零通道算变化，消失的非零通道也算变化
            changed += snap[common..].iter().filter(|&&v| v != 0).count();
            changed += prev[common..].iter().filter(|&&v| v != 0).count();
            let peak = snap.iter().copied().max().unwrap_or(0);

            let c = &mut self.change[r][idx];
            *c = c.saturating_add(u32::try_from(changed).unwrap_or(u32::MAX));
            let l = &mut self.level[r][idx];
            *l = (*l).max(peak);
            self.last_level[r] = peak;

            let p = &mut self.prev[r];
            p.clear();
            p.extend_from_slice(snap);
        }
        self.touch(idx);
    }

    /// 导出从桶 `from` 到末尾的数据（不改变改动标记）。
    ///
    /// # Arguments
    ///
    /// * `from` - 第一个导出的桶下标；超过总桶数时按总桶数处理（行数据为空）。
    ///
    /// # Returns
    ///
    /// 覆盖 `[from, len)` 的 [`ActivityDelta`]。
    #[must_use]
    pub fn delta_since(&self, from: usize) -> ActivityDelta {
        let from = from.min(self.len);
        ActivityDelta {
            generation: self.generation,
            bucket_us: self.bucket_us,
            len: self.len,
            from,
            universes: self.universes.clone(),
            change: self
                .change
                .iter()
                .map(|row| row[from..].iter().map(|&n| scale_change(n)).collect())
                .collect(),
            level: self.level.iter().map(|row| row[from..].to_vec()).collect(),
            part_starts_us: self.part_starts_us.clone(),
        }
    }

    /// 全量导出。
    ///
    /// # Returns
    ///
    /// 覆盖全部桶（`from = 0`）的 [`ActivityDelta`]。
    #[must_use]
    pub fn snapshot(&self) -> ActivityDelta {
        self.delta_since(0)
    }

    /// 导出自上次调用以来被改动过的桶，并清空改动标记。
    ///
    /// # Returns
    ///
    /// 从最小改动桶到末尾的 [`ActivityDelta`]；没有改动时 `from = len` 且行数据为空。
    pub fn take_delta(&mut self) -> ActivityDelta {
        let from = self.dirty_from.take().unwrap_or(self.len);
        self.delta_since(from)
    }
}

#[cfg(test)]
mod tests {
    use super::{scale_change, ActivityTimeline, INITIAL_BUCKET_US, MAX_BUCKETS};

    fn snap(v: u8, n: usize) -> Vec<u8> {
        let mut s = vec![0u8; 8];
        s[..n].fill(v);
        s
    }

    #[test]
    fn scale_is_monotonic_and_saturates() {
        assert_eq!(scale_change(0), 0);
        assert_eq!(scale_change(1), 24);
        assert!(scale_change(10) < scale_change(100));
        assert_eq!(scale_change(1_000_000), 255);
    }

    #[test]
    fn observations_land_in_the_right_bucket() {
        let mut t = ActivityTimeline::new(vec![1, 2]);
        t.observe(0, &[snap(10, 2), snap(0, 0)]);
        t.observe(INITIAL_BUCKET_US * 3 + 5, &[snap(20, 2), snap(200, 1)]);
        let d = t.snapshot();
        assert_eq!(d.len, 4);
        assert_eq!(d.from, 0);
        assert_eq!(d.change[0][0], scale_change(2));
        assert_eq!(d.change[0][3], scale_change(2));
        assert_eq!(d.change[1][3], scale_change(1));
        assert_eq!(d.level[0][3], 20);
        assert_eq!(d.level[1][3], 200);
        // 中间两个桶没有帧：变化为 0，电平沿用桶 0 时的快照
        assert_eq!(d.change[0][1], 0);
        assert_eq!(d.level[0][1], 10);
        assert_eq!(d.level[1][2], 0);
    }

    #[test]
    fn idle_advance_keeps_level_without_change() {
        let mut t = ActivityTimeline::new(vec![1]);
        t.observe(0, &[snap(77, 3)]);
        t.advance_to(INITIAL_BUCKET_US * 5);
        let d = t.snapshot();
        assert_eq!(d.len, 6);
        assert!(d.change[0][1..].iter().all(|&c| c == 0));
        assert!(d.level[0].iter().all(|&l| l == 77));
    }

    #[test]
    fn same_snapshot_twice_counts_no_change() {
        let mut t = ActivityTimeline::new(vec![1]);
        t.observe(0, &[snap(5, 4)]);
        t.observe(INITIAL_BUCKET_US, &[snap(5, 4)]);
        let d = t.snapshot();
        assert_eq!(d.change[0][1], 0);
        assert_eq!(d.level[0][1], 5);
    }

    #[test]
    fn overflow_compacts_with_max_and_bumps_generation() {
        let mut t = ActivityTimeline::new(vec![1]);
        // 尖峰落在奇数桶 1，合并后应保留在桶 0
        t.observe(INITIAL_BUCKET_US, &[snap(250, 8)]);
        t.advance_to(INITIAL_BUCKET_US * (MAX_BUCKETS as u64 - 1));
        assert_eq!(t.len(), MAX_BUCKETS);
        let _ = t.take_delta();

        t.advance_to(INITIAL_BUCKET_US * MAX_BUCKETS as u64);
        assert_eq!(t.bucket_us(), INITIAL_BUCKET_US * 2);
        let d = t.take_delta();
        assert_eq!(d.generation, 1);
        assert_eq!(d.from, 0, "合并后应全量导出");
        assert_eq!(d.len, MAX_BUCKETS / 2 + 1);
        assert_eq!(d.change[0][0], scale_change(8));
        assert_eq!(d.level[0][0], 250);
    }

    #[test]
    fn take_delta_starts_from_first_touched_bucket() {
        let mut t = ActivityTimeline::new(vec![1]);
        t.observe(0, &[snap(1, 1)]);
        t.advance_to(INITIAL_BUCKET_US * 3);
        let first = t.take_delta();
        assert_eq!((first.from, first.len), (0, 4));

        let none = t.take_delta();
        assert_eq!(none.from, 4);
        assert!(none.change[0].is_empty());

        t.observe(INITIAL_BUCKET_US * 3 + 10, &[snap(9, 1)]);
        t.advance_to(INITIAL_BUCKET_US * 5);
        let d = t.take_delta();
        assert_eq!(d.from, 3);
        assert_eq!(d.change[0].len(), 3);
        assert_eq!(d.level[0][0], 9);

        assert_eq!(t.delta_since(99).from, t.len());
    }

    #[test]
    fn part_starts_are_recorded_in_order() {
        let mut t = ActivityTimeline::new(vec![1]);
        t.mark_part(1_000_000);
        t.mark_part(500_000); // 倒退的起点被忽略
        t.mark_part(2_000_000);
        assert_eq!(t.snapshot().part_starts_us, vec![0, 1_000_000, 2_000_000]);
    }

    #[test]
    fn empty_universe_set_never_grows() {
        let mut t = ActivityTimeline::new(Vec::new());
        t.observe(1_000_000, &[]);
        assert!(t.is_empty());
        let d = t.snapshot();
        assert!(d.universes.is_empty() && d.change.is_empty());
    }
}

//! 多源合并算法（HTP / LTP / Priority）与冲突检测。
//!
//! 核心实现对来源类型泛型（crate 内部的 `MergeInput`），同时服务于：
//!
//! - 公开的 [`merge`]：基于 [`SourceView`]，返回新分配的 [`MergeResult`]（语义保持不变）；
//! - 引擎内部的急切合并：直接基于来源条目写入定长缓冲，热路径零分配。
//!
//! 内循环统一写成 `iter_mut().zip()` 的逐元素形式，便于编译器自动向量化。

use serde::{Deserialize, Serialize};

/// 冲突计数时逐块统计 min / max 的块宽（栈上缓冲，便于自动向量化）。
const CONFLICT_CHUNK: usize = 128;

/// 合并模式。
///
/// 全工程唯一定义：配置层（settings）与引擎层共用此类型，避免重复定义与手工转换。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub enum MergeMode {
    /// 最高值优先（逐通道取最大）。
    Htp,
    /// 最新值优先（后到源覆盖先到源）。
    Ltp,
    /// 优先级优先（最高优先级胜出，平级回落 HTP）。
    Priority,
}

impl MergeMode {
    /// 稳定的小写标识符（用于录制元数据等需要字符串表示的场合）。
    ///
    /// # Returns
    ///
    /// `"htp"` / `"ltp"` / `"priority"` 之一。
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Htp => "htp",
            Self::Ltp => "ltp",
            Self::Priority => "priority",
        }
    }
}

/// 参与合并的单个源快照（只读视图）。
#[derive(Debug, Clone)]
pub struct SourceView<'a> {
    /// 通道数据。
    pub data: &'a [u8],
    /// 优先级。
    pub priority: u8,
    /// 最后更新逻辑时间（毫秒）。
    pub last_seen_ms: u64,
    /// 同毫秒内的到达序（用于 LTP 稳定排序）。
    pub order: u64,
}

/// 合并结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergeResult {
    /// 合并后的输出缓冲。
    pub data: Vec<u8>,
    /// 存在分歧（≥2 源取值不同）的通道数。
    pub conflict_channels: usize,
    /// 参与合并的源数量。
    pub source_count: usize,
}

/// 合并算法所需的来源只读访问（crate 内部抽象，让 [`SourceView`] 与引擎的来源条目共用同一实现）。
pub(crate) trait MergeInput {
    /// 返回该来源的通道数据。
    fn data(&self) -> &[u8];

    /// 返回该来源的优先级。
    fn priority(&self) -> u8;

    /// 返回 LTP 排序键 `(last_seen_ms, order)`，越大越新。
    fn ltp_key(&self) -> (u64, u64);
}

impl MergeInput for SourceView<'_> {
    fn data(&self) -> &[u8] {
        self.data
    }

    fn priority(&self) -> u8 {
        self.priority
    }

    fn ltp_key(&self) -> (u64, u64) {
        (self.last_seen_ms, self.order)
    }
}

/// 按指定模式合并多个源。
///
/// # Arguments
///
/// * `sources` - 参与合并的源视图集合。
/// * `mode` - 合并模式。
///
/// # Returns
///
/// 合并结果，输出宽度等于各源中的最大通道长度；`conflict_channels` 为被 ≥2 个源覆盖
/// 且这些源取值不全相同的通道数。
#[must_use]
pub fn merge(sources: &[SourceView<'_>], mode: MergeMode) -> MergeResult {
    let mut data = vec![0u8; merged_width(sources)];
    merge_into(sources, mode, &mut data);
    MergeResult {
        data,
        conflict_channels: count_conflicts(sources),
        source_count: sources.len(),
    }
}

/// 合并输出宽度：各源通道长度的最大值（无源时为 `0`）。
///
/// # Arguments
///
/// * `sources` - 参与合并的来源。
///
/// # Returns
///
/// 最大通道长度。
pub(crate) fn merged_width<S: MergeInput>(sources: &[S]) -> usize {
    sources.iter().map(|s| s.data().len()).max().unwrap_or(0)
}

/// 按模式把合并结果写入调用方缓冲（不分配）。
///
/// 只写 `out[..width]`（`width` 为各源最大宽度与 `out.len()` 的较小者），其余部分不动；
/// `out` 原有内容无需清零。
///
/// # Arguments
///
/// * `sources` - 参与合并的来源。
/// * `mode` - 合并模式。
/// * `out` - 输出缓冲。
///
/// # Returns
///
/// 实际写入的宽度 `width`。
pub(crate) fn merge_into<S: MergeInput>(sources: &[S], mode: MergeMode, out: &mut [u8]) -> usize {
    let width = merged_width(sources).min(out.len());
    // width ≤ out.len()，切片必然在界内
    let out = &mut out[..width];
    match mode {
        MergeMode::Htp => htp_into(sources.iter(), out),
        MergeMode::Ltp => ltp_into(sources, out),
        MergeMode::Priority => {
            // 仅最高优先级的源参与 HTP，平级回落；宽度仍取全部来源的最大宽度。
            let top = sources.iter().map(MergeInput::priority).max().unwrap_or(0);
            htp_into(sources.iter().filter(|s| s.priority() == top), out);
        }
    }
    width
}

/// 逐通道取最大（HTP），结果覆盖整个 `out`；窄源只参与自己覆盖的通道。
///
/// # Arguments
///
/// * `sources` - 参与 HTP 的来源迭代器（Priority 模式传入过滤后的迭代器，无需中间集合）。
/// * `out` - 输出缓冲（长度即合并宽度）。
fn htp_into<'a, S: MergeInput + 'a>(mut sources: impl Iterator<Item = &'a S>, out: &mut [u8]) {
    let Some(first) = sources.next() else {
        out.fill(0);
        return;
    };
    // 第一个源直接拷贝（等价于与全 0 取 max），未覆盖的尾部清零
    let src = first.data();
    let n = src.len().min(out.len());
    let (head, tail) = out.split_at_mut(n);
    head.copy_from_slice(&src[..n]);
    tail.fill(0);
    for s in sources {
        // 无分支逐元素取 max，zip 自动按较短长度收敛，便于编译器向量化。
        for (slot, &v) in out.iter_mut().zip(s.data()) {
            *slot = (*slot).max(v);
        }
    }
}

/// 最新值优先（LTP），结果覆盖整个 `out`。
///
/// 每个通道取“覆盖该通道的来源中 `(last_seen_ms, order, 下标)` 最大者”的值，与旧实现
/// “按 `(last_seen_ms, order)` 稳定升序逐个覆盖”完全等价（平级时下标靠后者最后覆盖）。
/// 从最新来源往旧来源逐个处理，每个来源只需填补比它更新的来源都没覆盖到的尾部，
/// 因此无需排序与临时索引数组；覆盖满 `out` 后提前结束。
///
/// # Arguments
///
/// * `sources` - 参与合并的来源。
/// * `out` - 输出缓冲（长度即合并宽度）。
fn ltp_into<S: MergeInput>(sources: &[S], out: &mut [u8]) {
    let mut covered = 0usize;
    // 上一个已处理来源的键；下一轮只在严格更旧的来源中挑最新者
    let mut upper: Option<(u64, u64, usize)> = None;
    while covered < out.len() {
        let newest = sources
            .iter()
            .enumerate()
            .map(|(i, s)| {
                let (seen, order) = s.ltp_key();
                (seen, order, i)
            })
            .filter(|key| upper.is_none_or(|u| *key < u))
            .max();
        let Some(key) = newest else { break };
        upper = Some(key);
        let Some(src) = sources.get(key.2).map(MergeInput::data) else {
            break;
        };
        let end = src.len().min(out.len());
        if end > covered {
            out[covered..end].copy_from_slice(&src[covered..end]);
            covered = end;
        }
    }
    // 最宽来源必然覆盖整个宽度，这里只是防御：保证不残留调用方缓冲里的旧数据
    out[covered..].fill(0);
}

/// 统计冲突通道数：某通道被 ≥2 个来源覆盖且这些来源取值不全相同即计一个。
///
/// 按各源宽度把通道划分为若干段，每段内覆盖它的来源集合固定；覆盖数 ≥2 的段再按块
/// 逐通道求 min / max，`min != max` 即为冲突（与“存在取值不同于第一个覆盖源”等价）。
///
/// # Arguments
///
/// * `sources` - 参与合并的来源。
///
/// # Returns
///
/// 冲突通道数；来源少于 2 个时为 `0`。
pub(crate) fn count_conflicts<S: MergeInput>(sources: &[S]) -> usize {
    if sources.len() < 2 {
        return 0;
    }
    let mut count = 0;
    let mut lo = 0usize;
    loop {
        // 覆盖 `lo` 的来源数，以及它们之中最短的宽度（本段终点）
        let mut covering = 0usize;
        let mut hi = usize::MAX;
        for s in sources {
            let len = s.data().len();
            if len > lo {
                covering += 1;
                hi = hi.min(len);
            }
        }
        // 覆盖数随 `lo` 单调不增，一旦不足 2 之后都不可能再有冲突
        if covering < 2 {
            return count;
        }
        count += count_differing(sources, lo, hi);
        lo = hi;
    }
}

/// 统计 `[lo, hi)` 段内覆盖来源取值不全相同的通道数。
///
/// 调用方保证：段内覆盖集合固定，即每个来源的宽度要么 `≤ lo`（不覆盖），要么 `≥ hi`。
///
/// # Arguments
///
/// * `sources` - 全部来源（不覆盖本段的来源会被自动跳过）。
/// * `lo` - 段起点（含）。
/// * `hi` - 段终点（不含）。
///
/// # Returns
///
/// 段内冲突通道数。
fn count_differing<S: MergeInput>(sources: &[S], lo: usize, hi: usize) -> usize {
    let mut count = 0;
    let mut start = lo;
    while start < hi {
        let end = hi.min(start.saturating_add(CONFLICT_CHUNK));
        let mut mins = [u8::MAX; CONFLICT_CHUNK];
        let mut maxs = [u8::MIN; CONFLICT_CHUNK];
        for s in sources {
            // 不覆盖本段的来源（宽度 ≤ lo）在这里取不到切片，自然被跳过
            let Some(chunk) = s.data().get(start..end) else {
                continue;
            };
            for ((lo_v, hi_v), &v) in mins.iter_mut().zip(maxs.iter_mut()).zip(chunk) {
                *lo_v = (*lo_v).min(v);
                *hi_v = (*hi_v).max(v);
            }
        }
        let n = end - start;
        count += mins[..n]
            .iter()
            .zip(&maxs[..n])
            .filter(|(lo_v, hi_v)| lo_v != hi_v)
            .count();
        start = end;
    }
    count
}

#[cfg(test)]
mod tests {
    use super::{merge, merge_into, MergeMode, SourceView};

    fn sv(data: &[u8], priority: u8, last_seen_ms: u64, order: u64) -> SourceView<'_> {
        SourceView {
            data,
            priority,
            last_seen_ms,
            order,
        }
    }

    #[test]
    fn htp_takes_max_per_channel() {
        let a = [10u8, 200, 0];
        let b = [50u8, 100, 5];
        let r = merge(&[sv(&a, 100, 1, 0), sv(&b, 100, 2, 1)], MergeMode::Htp);
        assert_eq!(r.data, vec![50, 200, 5]);
        assert_eq!(r.source_count, 2);
    }

    #[test]
    fn ltp_latest_source_wins() {
        let old = [10u8, 10, 10];
        let new = [20u8, 20, 20];
        // new 的 last_seen 更大 → 覆盖
        let r = merge(&[sv(&old, 100, 1, 0), sv(&new, 100, 5, 1)], MergeMode::Ltp);
        assert_eq!(r.data, vec![20, 20, 20]);
    }

    #[test]
    fn ltp_narrow_newest_keeps_older_tail() {
        let wide_old = [1u8, 1, 1, 1];
        let narrow_new = [9u8, 9];
        let r = merge(
            &[sv(&wide_old, 100, 1, 0), sv(&narrow_new, 100, 2, 1)],
            MergeMode::Ltp,
        );
        assert_eq!(r.data, vec![9, 9, 1, 1]);
    }

    #[test]
    fn ltp_tie_later_index_wins() {
        let a = [1u8, 1];
        let b = [2u8, 2];
        // 键完全相同：与稳定排序后逐个覆盖一致，下标靠后者胜出
        let r = merge(&[sv(&a, 100, 3, 3), sv(&b, 100, 3, 3)], MergeMode::Ltp);
        assert_eq!(r.data, vec![2, 2]);
    }

    #[test]
    fn priority_highest_wins_ties_htp() {
        let low = [255u8, 255, 255];
        let hi_a = [10u8, 0, 0];
        let hi_b = [0u8, 20, 0];
        let r = merge(
            &[
                sv(&low, 50, 3, 0),
                sv(&hi_a, 200, 1, 1),
                sv(&hi_b, 200, 2, 2),
            ],
            MergeMode::Priority,
        );
        // 低优先级被忽略，两个 200 优先级做 HTP
        assert_eq!(r.data, vec![10, 20, 0]);
    }

    #[test]
    fn conflict_counts_differing_overlap() {
        let a = [10u8, 50, 0];
        let b = [20u8, 50, 0];
        // 通道0 分歧(10 vs 20)，通道1 相同(50)，通道2 相同(0)
        let r = merge(&[sv(&a, 100, 1, 0), sv(&b, 100, 2, 1)], MergeMode::Htp);
        assert_eq!(r.conflict_channels, 1);
    }

    #[test]
    fn conflict_ignores_channels_covered_by_one_source() {
        let a = [1u8, 2, 3, 4, 5];
        let b = [1u8, 9];
        let c = [7u8, 2, 3];
        // 通道0：1/1/7 分歧；通道1：2/9/2 分歧；通道2：3/3 相同；通道3~4 仅 a 覆盖
        let r = merge(
            &[sv(&a, 100, 1, 0), sv(&b, 100, 2, 1), sv(&c, 100, 3, 2)],
            MergeMode::Htp,
        );
        assert_eq!(r.conflict_channels, 2);
    }

    #[test]
    fn single_source_no_conflict() {
        let a = [1u8, 2, 3];
        let r = merge(&[sv(&a, 100, 1, 0)], MergeMode::Htp);
        assert_eq!(r.conflict_channels, 0);
        assert_eq!(r.data, vec![1, 2, 3]);
    }

    #[test]
    fn differing_width_padded() {
        let a = [100u8, 100];
        let b = [0u8, 0, 50, 60];
        let r = merge(&[sv(&a, 100, 1, 0), sv(&b, 100, 2, 1)], MergeMode::Htp);
        assert_eq!(r.data, vec![100, 100, 50, 60]);
    }

    #[test]
    fn no_sources_yields_empty_output() {
        for mode in [MergeMode::Htp, MergeMode::Ltp, MergeMode::Priority] {
            let r = merge(&[], mode);
            assert!(r.data.is_empty());
            assert_eq!((r.conflict_channels, r.source_count), (0, 0));
        }
    }

    #[test]
    fn merge_into_overwrites_dirty_buffer_and_reports_width() {
        let a = [1u8, 0, 3];
        let b = [0u8, 2];
        for mode in [MergeMode::Htp, MergeMode::Ltp, MergeMode::Priority] {
            let mut out = [0xAAu8; 8];
            let width = merge_into(&[sv(&a, 100, 1, 0), sv(&b, 100, 2, 1)], mode, &mut out);
            assert_eq!(width, 3);
            assert_eq!(&out[3..], &[0xAA; 5], "宽度之外不应被改写");
            let expected = merge(&[sv(&a, 100, 1, 0), sv(&b, 100, 2, 1)], mode).data;
            assert_eq!(&out[..width], expected.as_slice());
        }
    }
}

//! 多源合并算法（HTP / LTP / Priority）与冲突检测。

use serde::Serialize;

/// 合并模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MergeMode {
    /// 最高值优先（逐通道取最大）。
    Htp,
    /// 最新值优先（后到源覆盖先到源）。
    Ltp,
    /// 优先级优先（最高优先级胜出，平级回落 HTP）。
    Priority,
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

/// 按指定模式合并多个源。
///
/// # Arguments
///
/// * `sources` - 参与合并的源视图集合。
/// * `mode` - 合并模式。
///
/// # Returns
///
/// 合并结果，输出宽度等于各源中的最大通道长度。
#[must_use]
pub fn merge(sources: &[SourceView<'_>], mode: MergeMode) -> MergeResult {
    let width = sources.iter().map(|s| s.data.len()).max().unwrap_or(0);
    let conflict_channels = count_conflicts(sources, width);

    let data = match mode {
        MergeMode::Htp => htp(sources, width),
        MergeMode::Ltp => ltp(sources, width),
        MergeMode::Priority => {
            let top = sources.iter().map(|s| s.priority).max().unwrap_or(0);
            let filtered: Vec<SourceView<'_>> = sources
                .iter()
                .filter(|s| s.priority == top)
                .cloned()
                .collect();
            htp(&filtered, width)
        }
    };

    MergeResult {
        data,
        conflict_channels,
        source_count: sources.len(),
    }
}

fn htp(sources: &[SourceView<'_>], width: usize) -> Vec<u8> {
    let mut out = vec![0u8; width];
    for s in sources {
        for (i, &v) in s.data.iter().enumerate() {
            if v > out[i] {
                out[i] = v;
            }
        }
    }
    out
}

fn ltp(sources: &[SourceView<'_>], width: usize) -> Vec<u8> {
    let mut idx: Vec<usize> = (0..sources.len()).collect();
    // 按 (last_seen_ms, order) 升序：最新者排后，最后覆盖
    idx.sort_by_key(|&i| (sources[i].last_seen_ms, sources[i].order));
    let mut out = vec![0u8; width];
    for &i in &idx {
        for (c, &v) in sources[i].data.iter().enumerate() {
            out[c] = v;
        }
    }
    out
}

fn count_conflicts(sources: &[SourceView<'_>], width: usize) -> usize {
    if sources.len() < 2 {
        return 0;
    }
    let mut count = 0;
    for c in 0..width {
        let mut first: Option<u8> = None;
        let mut covering = 0usize;
        let mut differ = false;
        for s in sources {
            if let Some(&v) = s.data.get(c) {
                covering += 1;
                match first {
                    None => first = Some(v),
                    Some(f) if f != v => differ = true,
                    _ => {}
                }
            }
        }
        if covering >= 2 && differ {
            count += 1;
        }
    }
    count
}

#[cfg(test)]
mod tests {
    use super::{merge, MergeMode, SourceView};

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
}

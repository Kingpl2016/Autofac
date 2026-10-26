//! 概览扫描的字节级内循环（crate 内部使用）。
//!
//! 写成固定宽度分块 + 定长数组的形式，便于 LLVM 自动向量化（`pcmpeqb`/`psubb`/`pmaxub` 等），
//! 不依赖任何平台专有 intrinsic；结果与朴素逐字节写法逐位相同。

/// 统计 `a`、`b` 在相同位置上不相等的字节数（按两者中较短者的长度比较）。
///
/// 与 `a.iter().zip(b).filter(|(x, y)| x != y).count()` 结果相同。
///
/// # Arguments
///
/// * `a` - 第一段字节。
/// * `b` - 第二段字节。
///
/// # Returns
///
/// 不相等的位置数。DMX 缓冲长度不超过 `u16::MAX`，计数不会溢出 `u32`。
pub(crate) fn count_diff(a: &[u8], b: &[u8]) -> u32 {
    let n = a.len().min(b.len());
    let (a, b) = (&a[..n], &b[..n]);
    let (ac, at) = a.as_chunks::<64>();
    let (bc, bt) = b.as_chunks::<64>();
    let mut total = 0u32;
    for (x, y) in ac.iter().zip(bc) {
        // 每块至多 64 个不等位置，u8 累加不会回绕
        let block = x
            .iter()
            .zip(y)
            .fold(0u8, |acc, (p, q)| acc.wrapping_add(u8::from(p != q)));
        total += u32::from(block);
    }
    total
        + at.iter()
            .zip(bt)
            .fold(0u32, |acc, (p, q)| acc + u32::from(p != q))
}

/// 字节切片的最大值；空切片返回 0。
///
/// 与 `a.iter().copied().max().unwrap_or(0)` 结果相同。
///
/// # Arguments
///
/// * `a` - 待求最大值的字节。
///
/// # Returns
///
/// 最大字节值；`a` 为空时为 `0`。
pub(crate) fn max_byte(a: &[u8]) -> u8 {
    let (chunks, tail) = a.as_chunks::<32>();
    let mut lanes = [0u8; 32];
    for c in chunks {
        for (m, &v) in lanes.iter_mut().zip(c) {
            *m = (*m).max(v);
        }
    }
    let head = lanes.iter().copied().fold(0u8, u8::max);
    tail.iter().copied().fold(head, u8::max)
}

#[cfg(test)]
mod tests {
    use super::{count_diff, max_byte};
    use crate::testgen::XorShift;

    fn naive_diff(a: &[u8], b: &[u8]) -> u32 {
        a.iter().zip(b).filter(|(x, y)| x != y).count() as u32
    }

    fn naive_max(a: &[u8]) -> u8 {
        a.iter().copied().max().unwrap_or(0)
    }

    #[test]
    fn kernels_match_naive_versions_for_all_lengths_and_densities() {
        let mut rng = XorShift::new(0x5EED_0001);
        for len in (0usize..=200).chain([255, 256, 257, 511, 512, 513, 1000, 4096]) {
            for density in [0u32, 1, 10, 50, 100] {
                let a: Vec<u8> = (0..len).map(|_| rng.byte()).collect();
                let mut b = a.clone();
                for v in &mut b {
                    if rng.below(100) < u64::from(density) {
                        *v = v.wrapping_add(1 + (rng.below(255) as u8));
                    }
                }
                assert_eq!(
                    count_diff(&a, &b),
                    naive_diff(&a, &b),
                    "len={len} density={density}"
                );
                assert_eq!(max_byte(&a), naive_max(&a), "len={len}");
                assert_eq!(max_byte(&b), naive_max(&b), "len={len}");
                // 长度不同：按较短者比较
                let cut = rng.below(len as u64 + 1) as usize;
                assert_eq!(count_diff(&a[..cut], &b), naive_diff(&a[..cut], &b));
                assert_eq!(count_diff(&a, &b[..cut]), naive_diff(&a, &b[..cut]));
            }
        }
        // 最大值出现在尾部 / 分块内任意位置
        for len in [1usize, 31, 32, 33, 64, 65, 512] {
            for pos in 0..len {
                let mut a = vec![3u8; len];
                a[pos] = 250;
                assert_eq!(max_byte(&a), 250, "len={len} pos={pos}");
            }
        }
        assert_eq!(count_diff(&[0u8; 64], &[1u8; 64]), 64);
        assert_eq!(count_diff(&[0u8; 512], &[255u8; 512]), 512);
        assert_eq!(max_byte(&[]), 0);
    }
}

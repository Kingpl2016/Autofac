//! 回放通道流：把被查看 Universe 的当前回放输出编码为 [`StreamKind::Playback`] 帧。
//!
//! 与实时侧的 [`LiveChannels`](crate::stream::LiveChannels) 规则一致（帧格式见 [`crate::stream`]）：
//!
//! - 触发全量的条件：查看集合变化、通道流订阅变化（全量代次改变）、距上次全量满
//!   [`FULL_FRAME_INTERVAL`]；
//! - 增量帧只含与上次发送不同的 Universe；节目里有、但当前没有输出的 Universe
//!   （停止 / seek 到首帧之前）给出 `len = 0` 条目；
//! - 节目没有输出时全量帧为空，前端据此清空回放通道表。
//!
//! 变化检测直接比较字节（每路至多 512 字节），上次发送的数据存在按查看集合排列的复用缓冲里，
//! 每个节拍不分配。

use std::time::Instant;

use crate::stream::{FrameWriter, StreamKind, FLAG_FULL, FULL_FRAME_INTERVAL};

/// 某个被查看 Universe 上次发给前端的数据。
#[derive(Debug, Default)]
struct Sent {
    /// 前端是否持有该 Universe 的数据。
    has: bool,
    /// 上次发送的数据（`has` 为 `true` 时有效；容量复用）。
    data: Vec<u8>,
}

/// 回放通道流的变化检测与编码（回放线程每个 UI 节拍调用一次）。
#[derive(Debug, Default)]
pub(crate) struct PlaybackChannels {
    /// 当前查看集合（按前端给出的顺序）。
    viewed: Vec<u16>,
    /// 与 `viewed` 一一对应：该 Universe 在节目 Universe 表里的下标；不在节目里为 `None`。
    index: Vec<Option<usize>>,
    /// 与 `viewed` 一一对应：上次发送的数据。
    sent: Vec<Sent>,
    /// 帧编码器。
    writer: FrameWriter,
    /// 上次看到的全量代次。
    epoch: Option<u64>,
    /// 上次全量帧的时刻。
    last_full: Option<Instant>,
}

impl PlaybackChannels {
    /// 创建变化检测器；第一帧必为全量。
    ///
    /// # Returns
    ///
    /// 空的 [`PlaybackChannels`]。
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// 编码本节拍的回放帧。
    ///
    /// # Arguments
    ///
    /// * `viewed` - 前端当前查看的 Universe。
    /// * `ids` - 节目的 Universe 编号（与 `buffers` 一一对应；同一实例的生命周期内不变）。
    /// * `buffers` - 回放器当前的输出状态（[`player::Player::buffers`]）；`None` 表示当前没有输出。
    /// * `epoch` - 通道流的全量代次（[`DmxStream::epoch`](crate::stream::DmxStream::epoch)）。
    /// * `now` - 当前时刻。
    ///
    /// # Returns
    ///
    /// 需要发送时返回整帧字节；增量且没有任何变化时返回 `None`。
    pub(crate) fn encode(
        &mut self,
        viewed: &[u16],
        ids: &[u16],
        buffers: Option<&[Vec<u8>]>,
        epoch: u64,
        now: Instant,
    ) -> Option<Vec<u8>> {
        let viewed_changed = self.viewed != viewed;
        if viewed_changed {
            self.viewed.clear();
            self.viewed.extend_from_slice(viewed);
            self.index.clear();
            self.index
                .extend(viewed.iter().map(|u| ids.iter().position(|x| x == u)));
            self.sent.resize_with(viewed.len(), Sent::default);
            for s in &mut self.sent {
                s.has = false;
            }
        }
        let epoch_changed = self.epoch != Some(epoch);
        self.epoch = Some(epoch);
        let stale = self
            .last_full
            .is_none_or(|t| now.saturating_duration_since(t) >= FULL_FRAME_INTERVAL);
        let full = viewed_changed || epoch_changed || stale;
        if full {
            self.last_full = Some(now);
        }

        self.writer
            .begin(StreamKind::Playback, if full { FLAG_FULL } else { 0 });
        let entries = self.viewed.iter().zip(&self.index).zip(&mut self.sent);
        for ((&universe, idx), sent) in entries {
            let current = buffers
                .zip(*idx)
                .and_then(|(b, i)| b.get(i))
                .map(Vec::as_slice);
            if let Some(data) = current {
                let same = sent.has && sent.data == data;
                if full || !same {
                    self.writer.push(universe, data);
                }
                if !same {
                    sent.has = true;
                    sent.data.clear();
                    sent.data.extend_from_slice(data);
                }
            } else {
                // 全量帧里省略即表示移除；增量帧需要显式的 len = 0
                if !full && sent.has {
                    self.writer.push(universe, &[]);
                }
                sent.has = false;
            }
        }
        if !full && self.writer.count() == 0 {
            return None;
        }
        Some(self.writer.finish())
    }

    /// 空的回放全量帧：节目关闭时发出，让前端清空回放通道表。
    ///
    /// # Returns
    ///
    /// 只有帧头、条目数为 0 的 [`StreamKind::Playback`] 全量帧。
    pub(crate) fn empty_full_frame() -> Vec<u8> {
        let mut w = FrameWriter::new();
        w.begin(StreamKind::Playback, FLAG_FULL);
        w.finish()
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::PlaybackChannels;
    use crate::stream::{FLAG_FULL, HEADER_LEN};

    /// 解析后的帧：（类别, 标志位, 条目）。
    type Parsed = (u8, u8, Vec<(u16, Vec<u8>)>);

    /// 测试用解码器（与前端 `decodeDmxFrame` 同一格式）。
    fn parse(buf: &[u8]) -> Parsed {
        assert!(buf.len() >= HEADER_LEN);
        let count = u16::from_le_bytes([buf[4], buf[5]]);
        let mut at = HEADER_LEN;
        let mut entries = Vec::new();
        for _ in 0..count {
            let universe = u16::from_le_bytes([buf[at], buf[at + 1]]);
            let len = usize::from(u16::from_le_bytes([buf[at + 2], buf[at + 3]]));
            at += 4;
            entries.push((universe, buf[at..at + len].to_vec()));
            at += len;
        }
        assert_eq!(at, buf.len());
        (buf[2], buf[3], entries)
    }

    #[test]
    fn sends_full_then_only_changes_and_len_zero_when_output_stops() {
        let mut ch = PlaybackChannels::new();
        let ids = [5u16, 6, 7];
        let mut bufs = vec![vec![1u8, 1], vec![2, 2], vec![3, 3]];
        let t0 = Instant::now();
        let ms = |n: u64| t0 + Duration::from_millis(n);
        let mut run = |bufs: Option<&[Vec<u8>]>, viewed: &[u16], epoch: u64, at: Instant| {
            ch.encode(viewed, &ids, bufs, epoch, at).map(|b| parse(&b))
        };

        // 首帧全量；不在节目里的 Universe 9 被忽略
        assert_eq!(
            run(Some(&bufs), &[6, 5, 9], 1, t0),
            Some((2, FLAG_FULL, vec![(6, vec![2, 2]), (5, vec![1, 1])]))
        );
        // 没有变化：不发送
        assert_eq!(run(Some(&bufs), &[6, 5, 9], 1, ms(33)), None);
        // 只有 5 变化；未查看的 7 变化不触发
        bufs[0][1] = 9;
        bufs[2][0] = 9;
        assert_eq!(
            run(Some(&bufs), &[6, 5, 9], 1, ms(66)),
            Some((2, 0, vec![(5, vec![1, 9])]))
        );
        // 停止（没有输出）：增量给出 len = 0，之后不重复
        assert_eq!(
            run(None, &[6, 5, 9], 1, ms(99)),
            Some((2, 0, vec![(6, vec![]), (5, vec![])]))
        );
        assert_eq!(run(None, &[6, 5, 9], 1, ms(132)), None);
        // 恢复输出：增量重新给出数据
        assert_eq!(
            run(Some(&bufs), &[6, 5, 9], 1, ms(165)),
            Some((2, 0, vec![(6, vec![2, 2]), (5, vec![1, 9])]))
        );
    }

    #[test]
    fn forces_full_on_viewed_epoch_and_interval_and_empty_without_output() {
        let mut ch = PlaybackChannels::new();
        let ids = [1u16, 2];
        let bufs = vec![vec![10u8], vec![20]];
        let t0 = Instant::now();
        let ms = |n: u64| t0 + Duration::from_millis(n);
        let mut run = |bufs: Option<&[Vec<u8>]>, viewed: &[u16], epoch: u64, at: Instant| {
            ch.encode(viewed, &ids, bufs, epoch, at).map(|b| parse(&b))
        };
        assert!(run(Some(&bufs), &[1], 4, t0).is_some());
        assert_eq!(run(Some(&bufs), &[1], 4, ms(10)), None);

        // 查看集合变化：全量
        let viewed = run(Some(&bufs), &[2, 1], 4, ms(20)).unwrap();
        assert_eq!(viewed, (2, FLAG_FULL, vec![(2, vec![20]), (1, vec![10])]));
        // 代次变化（新订阅 / request_full）：全量
        assert_eq!(run(Some(&bufs), &[2, 1], 5, ms(30)).unwrap().1, FLAG_FULL);
        assert_eq!(run(Some(&bufs), &[2, 1], 5, ms(500)), None);
        // 距上次全量满 1 秒：全量兜底
        let beat = run(Some(&bufs), &[2, 1], 5, ms(1030)).unwrap();
        assert_eq!((beat.1, beat.2.len()), (FLAG_FULL, 2));
        // 没有输出时的全量帧为空
        assert_eq!(
            run(None, &[2, 1], 6, ms(1040)),
            Some((2, FLAG_FULL, vec![]))
        );
    }

    #[test]
    fn empty_full_frame_is_a_bare_playback_header() {
        assert_eq!(
            PlaybackChannels::empty_full_frame(),
            [0x44, 1, 2, FLAG_FULL, 0, 0]
        );
    }
}

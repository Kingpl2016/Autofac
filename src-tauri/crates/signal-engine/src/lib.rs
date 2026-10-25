//! DMX 接收管线：Universe 多源状态跟踪、合并（HTP/LTP/Priority）、源超时与统计快照。
//!
//! 引擎使用逻辑时间（毫秒）驱动，便于确定性测试；真实时钟由宿主层注入。

mod engine;
mod merge;
mod state;

pub use engine::{SignalEngine, SourceStat, UniverseSnapshot};
pub use merge::{merge, MergeMode, MergeResult, SourceView};
pub use state::{unknown_source, SourceEntry, SourceKey, UniverseState};

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr};

    use artnet_net::{Bytes, DmxFrame, Protocol};

    use super::{MergeMode, SignalEngine};

    fn frame(universe: u16, ip: [u8; 4], data: Vec<u8>) -> DmxFrame {
        DmxFrame {
            protocol: Protocol::ArtNet,
            universe,
            data: Bytes::from(data),
            source: Some(IpAddr::V4(Ipv4Addr::from(ip))),
            sequence: 0,
            received_at: std::time::Instant::now(),
        }
    }

    #[test]
    fn purge_protocol_removes_only_that_protocol() {
        let mut eng = SignalEngine::new(MergeMode::Htp, 2500);
        eng.ingest(&frame(1, [10, 0, 0, 1], vec![1]), 0);
        let mut sacn = frame(2, [10, 0, 0, 2], vec![2]);
        sacn.protocol = Protocol::Sacn;
        eng.ingest(&sacn, 0);
        assert_eq!(eng.active_universe_count(), 2);

        assert_eq!(eng.purge_protocol(Protocol::Sacn), 1);
        let snap = eng.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].universe, 1, "Art-Net 的 Universe 应保留");
        // 重复清理是幂等的
        assert_eq!(eng.purge_protocol(Protocol::Sacn), 0);
    }

    #[test]
    fn ingest_and_snapshot() {
        let mut eng = SignalEngine::new(MergeMode::Htp, 2500);
        eng.ingest(&frame(1, [10, 0, 0, 1], vec![0, 255, 0]), 0);
        eng.ingest(&frame(5, [10, 0, 0, 2], vec![100, 0, 0]), 0);
        assert_eq!(eng.active_universe_count(), 2);
        let snap = eng.snapshot();
        assert_eq!(snap.len(), 2);
        assert_eq!(snap[0].universe, 1);
        assert_eq!(snap[0].active_channels, 1);
        assert_eq!(snap[1].universe, 5);
    }

    #[test]
    fn two_sources_merge_htp() {
        let mut eng = SignalEngine::new(MergeMode::Htp, 2500);
        eng.ingest(&frame(1, [10, 0, 0, 1], vec![10, 200, 0]), 0);
        eng.ingest(&frame(1, [10, 0, 0, 2], vec![50, 100, 5]), 0);
        assert_eq!(eng.merged_output(1).unwrap(), vec![50, 200, 5]);
        let snap = eng.snapshot();
        assert_eq!(snap[0].source_count, 2);
        assert_eq!(snap[0].conflict_channels, 3); // 全部三通道取值不同
    }

    #[test]
    fn source_stats_aggregate_per_ip() {
        let mut eng = SignalEngine::new(MergeMode::Htp, 2500);
        eng.ingest(&frame(1, [10, 0, 0, 1], vec![1]), 0);
        eng.ingest(&frame(1, [10, 0, 0, 1], vec![2]), 1);
        eng.ingest(&frame(3, [10, 0, 0, 1], vec![3]), 2);
        eng.ingest(&frame(1, [10, 0, 0, 2], vec![4]), 3);
        let stats = eng.source_stats();
        assert_eq!(stats.len(), 2);
        assert_eq!(stats[0].ip, "10.0.0.1");
        assert_eq!(stats[0].universes, vec![1, 3]);
        assert_eq!(stats[0].packets, 3);
        assert_eq!(stats[1].ip, "10.0.0.2");
        assert_eq!(stats[1].universes, vec![1]);
    }

    #[test]
    fn source_timeout_prunes() {
        let mut eng = SignalEngine::new(MergeMode::Htp, 1000);
        eng.ingest(&frame(1, [10, 0, 0, 1], vec![1, 2, 3]), 0);
        eng.ingest(&frame(1, [10, 0, 0, 2], vec![4, 5, 6]), 500);
        // 推进到 1200ms：源1（0ms，超 1000）超时，源2（500ms，1200-500=700）保留
        let pruned = eng.prune(1200);
        assert_eq!(pruned, 1);
        let snap = eng.snapshot();
        assert_eq!(snap[0].source_count, 1);
        // 全部源超时后 Universe 移除
        eng.prune(5000);
        assert_eq!(eng.active_universe_count(), 0);
    }

    #[test]
    fn mode_switch_changes_output() {
        let mut eng = SignalEngine::new(MergeMode::Htp, 2500);
        eng.ingest(&frame(1, [10, 0, 0, 1], vec![10, 10, 10]), 0);
        eng.ingest(&frame(1, [10, 0, 0, 2], vec![20, 20, 20]), 5);
        assert_eq!(eng.merged_output(1).unwrap(), vec![20, 20, 20]); // HTP
        eng.set_mode(MergeMode::Ltp);
        assert_eq!(eng.merged_output(1).unwrap(), vec![20, 20, 20]); // LTP：源2更新
    }
}

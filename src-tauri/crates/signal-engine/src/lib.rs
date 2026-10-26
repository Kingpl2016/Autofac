//! DMX 接收管线：Universe 多源状态跟踪、合并（HTP/LTP/Priority）、源超时与统计快照。
//!
//! 引擎使用逻辑时间（毫秒）驱动，便于确定性测试；真实时钟由宿主层注入。
//! 合并结果在摄取时急切计算，读取路径（[`SignalEngine::merged`] /
//! [`SignalEngine::merged_bytes`]）零拷贝；冲突数仅在快照时惰性计算。

mod engine;
mod merge;
mod rate;
mod state;

#[cfg(test)]
mod equivalence;

pub use engine::{SignalEngine, SourceStat, UniverseSnapshot, UniverseSource};
pub use merge::{merge, MergeMode, MergeResult, SourceView};
pub use rate::{RateTracker, RATE_WINDOW_MS};
pub use state::unknown_source;

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

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
    fn clear_drops_all_universes_but_keeps_packet_counter() {
        let mut eng = SignalEngine::new(MergeMode::Htp, 2500);
        eng.ingest(&frame(1, [10, 0, 0, 1], vec![1]), 0);
        eng.ingest(&frame(2, [10, 0, 0, 2], vec![2]), 0);
        let packets = eng.total_packets();
        assert_eq!(eng.clear(), 2);
        assert!(eng.snapshot().is_empty());
        assert_eq!(eng.merged_output(1), None);
        assert_eq!(eng.total_packets(), packets, "累计包数不应回退");
        assert_eq!(eng.clear(), 0, "重复清理是幂等的");
        // 清空后仍可继续接收
        eng.ingest(&frame(3, [10, 0, 0, 3], vec![3]), 5);
        assert_eq!(eng.active_universe_count(), 1);
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
    fn snapshot_lists_per_source_packets_sorted_by_ip() {
        let mut eng = SignalEngine::new(MergeMode::Htp, 2500);
        eng.ingest(&frame(1, [10, 0, 0, 2], vec![1]), 0);
        eng.ingest(&frame(1, [10, 0, 0, 1], vec![2]), 1);
        eng.ingest(&frame(1, [10, 0, 0, 1], vec![3]), 2);
        let snap = eng.snapshot();
        let sources = &snap[0].sources;
        assert_eq!(sources.len(), 2);
        assert_eq!(sources[0].ip, "10.0.0.1");
        assert_eq!(sources[0].packets, 2);
        assert_eq!(sources[1].ip, "10.0.0.2");
        assert_eq!(sources[1].packets, 1);
        assert_eq!(snap[0].packet_rate, 0, "速率由 RateTracker 补齐");
        assert_eq!(sources[0].packet_rate, 0);
    }

    #[test]
    fn rate_tracker_fills_snapshot_from_engine() {
        let mut eng = SignalEngine::new(MergeMode::Htp, 2500);
        let mut tracker = crate::RateTracker::new();
        eng.ingest(&frame(1, [10, 0, 0, 1], vec![1]), 0);
        let mut snap = eng.snapshot();
        tracker.apply(&mut snap, eng.total_packets(), 0);
        for t in 1..=44u64 {
            eng.ingest(&frame(1, [10, 0, 0, 1], vec![1]), t * 20);
        }
        let mut snap = eng.snapshot();
        let total = tracker.apply(&mut snap, eng.total_packets(), 1000);
        assert_eq!(total, 44);
        assert_eq!(snap[0].packet_rate, 44);
        assert_eq!(snap[0].sources[0].packet_rate, 44);
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

    /// 期望 JSON 由改动前的实现对同一输入实际输出（逐字节捕获），用于锁定前端载荷不变。
    #[test]
    fn snapshot_and_source_stats_json_unchanged() {
        let mut eng = SignalEngine::new(MergeMode::Htp, 2500);
        let mut tracker = crate::RateTracker::new();
        eng.ingest(&frame(1, [10, 0, 0, 1], vec![10, 200, 0]), 0);
        eng.ingest(&frame(1, [10, 0, 0, 2], vec![50, 100, 5]), 0);
        let mut sacn = frame(7, [192, 168, 1, 20], vec![0, 0, 9, 0]);
        sacn.protocol = Protocol::Sacn;
        eng.ingest(&sacn, 3);
        let mut snap = eng.snapshot();
        tracker.apply(&mut snap, eng.total_packets(), 0);
        for t in 1..=10u64 {
            eng.ingest(&frame(1, [10, 0, 0, 2], vec![50, 100, 5]), t * 100);
        }
        let mut snap = eng.snapshot();
        tracker.apply(&mut snap, eng.total_packets(), 1000);
        assert_eq!(
            serde_json::to_string(&snap).unwrap(),
            concat!(
                r#"[{"universe":1,"protocol":"artNet","sourceIps":["10.0.0.1","10.0.0.2"],"#,
                r#""sourceCount":2,"activeChannels":3,"conflictChannels":3,"totalPackets":12,"#,
                r#""packetRate":10,"sources":[{"ip":"10.0.0.1","packets":1,"packetRate":0},"#,
                r#"{"ip":"10.0.0.2","packets":11,"packetRate":10}]},"#,
                r#"{"universe":7,"protocol":"sacn","sourceIps":["192.168.1.20"],"sourceCount":1,"#,
                r#""activeChannels":1,"conflictChannels":0,"totalPackets":1,"packetRate":0,"#,
                r#""sources":[{"ip":"192.168.1.20","packets":1,"packetRate":0}]}]"#,
            )
        );
        assert_eq!(
            serde_json::to_string(&eng.source_stats()).unwrap(),
            concat!(
                r#"[{"ip":"10.0.0.1","protocol":"artNet","universes":[1],"packets":1},"#,
                r#"{"ip":"10.0.0.2","protocol":"artNet","universes":[1],"packets":11},"#,
                r#"{"ip":"192.168.1.20","protocol":"sacn","universes":[7],"packets":1}]"#,
            )
        );
    }

    #[test]
    fn sources_sorted_numerically_not_lexically() {
        let mut eng = SignalEngine::new(MergeMode::Htp, 2500);
        let v6 = IpAddr::V6(Ipv6Addr::LOCALHOST);
        let mut f6 = frame(1, [0, 0, 0, 0], vec![1]);
        f6.source = Some(v6);
        eng.ingest(&f6, 0);
        eng.ingest(&frame(1, [10, 0, 0, 10], vec![1]), 0);
        eng.ingest(&frame(1, [10, 0, 0, 9], vec![1]), 0);
        let snap = eng.snapshot();
        // 字符串序会把 "10.0.0.10" 排在 "10.0.0.9" 之前；数值序则相反，且 IPv4 在 IPv6 之前
        let expected = ["10.0.0.9", "10.0.0.10", "::1"];
        assert_eq!(snap[0].source_ips, expected);
        let ips: Vec<&str> = snap[0].sources.iter().map(|s| s.ip.as_str()).collect();
        assert_eq!(ips, expected, "sources 与 source_ips 顺序一致");
        assert_eq!(snap[0].sources[2].addr, v6);
        let stats: Vec<String> = eng.source_stats().into_iter().map(|s| s.ip).collect();
        assert_eq!(stats, expected);
    }

    #[test]
    fn zero_copy_readers_agree() {
        let mut eng = SignalEngine::new(MergeMode::Htp, 2500);
        let single = Bytes::from(vec![1u8, 2, 3]);
        let mut f = frame(1, [10, 0, 0, 1], Vec::new());
        f.data = single.clone();
        eng.ingest(&f, 0);
        // 单来源：直接借用来源数据（同一块内存）
        let borrowed = eng.merged(1).unwrap();
        assert_eq!(borrowed.as_ptr(), single.as_ptr());
        assert_eq!(eng.merged_bytes(1).unwrap().as_ptr(), single.as_ptr());

        eng.ingest(&frame(1, [10, 0, 0, 2], vec![0, 9, 0, 4]), 1);
        assert_eq!(eng.merged(1).unwrap(), &[1, 9, 3, 4]);
        assert_eq!(
            eng.merged_bytes(1).unwrap(),
            Bytes::from_static(&[1, 9, 3, 4])
        );
        assert_eq!(eng.merged_output(1).unwrap(), vec![1, 9, 3, 4]);

        let mut out = [0xEEu8; 6];
        assert_eq!(eng.merged_into(1, &mut out), Some(4));
        assert_eq!(out, [1, 9, 3, 4, 0xEE, 0xEE]);
        let mut short = [0u8; 2];
        assert_eq!(eng.merged_into(1, &mut short), Some(2));
        assert_eq!(short, [1, 9]);

        assert_eq!(eng.merged(2), None);
        assert_eq!(eng.merged_bytes(2), None);
        assert_eq!(eng.merged_into(2, &mut out), None);
        assert_eq!(eng.data_gen(2), None);
    }

    #[test]
    fn data_gen_tracks_changes() {
        let mut eng = SignalEngine::new(MergeMode::Htp, 1000);
        eng.ingest(&frame(1, [10, 0, 0, 1], vec![10, 10]), 0);
        let g1 = eng.data_gen(1).unwrap();
        eng.ingest(&frame(1, [10, 0, 0, 2], vec![20, 5]), 500);
        let g2 = eng.data_gen(1).unwrap();
        assert_ne!(g1, g2, "ingest 必然更新代号");

        // 模式不变：不重算、代号不变
        eng.set_mode(MergeMode::Htp);
        assert_eq!(eng.data_gen(1), Some(g2));
        // 切到 LTP：多来源 Universe 重算并更新代号
        eng.set_mode(MergeMode::Ltp);
        let g3 = eng.data_gen(1).unwrap();
        assert_ne!(g2, g3);
        assert_eq!(eng.merged(1).unwrap(), &[20, 5]);

        // 没有来源被剔除：代号不变
        assert_eq!(eng.prune(900), 0);
        assert_eq!(eng.data_gen(1), Some(g3));
        // 源1 超时被剔除：回到单来源，代号更新
        assert_eq!(eng.prune(1200), 1);
        let g4 = eng.data_gen(1).unwrap();
        assert_ne!(g3, g4);
        assert_eq!(eng.merged(1).unwrap(), &[20, 5]);

        // 移除后重建：代号不会与旧值重复
        eng.clear();
        eng.ingest(&frame(1, [10, 0, 0, 1], vec![20, 5]), 1300);
        let g5 = eng.data_gen(1).unwrap();
        assert!(g5 > g4);
    }

    #[test]
    fn oversized_frame_is_truncated_to_512() {
        let mut eng = SignalEngine::new(MergeMode::Htp, 2500);
        eng.ingest(&frame(1, [10, 0, 0, 1], vec![7; 600]), 0);
        assert_eq!(eng.merged(1).unwrap().len(), 512);
        eng.ingest(&frame(1, [10, 0, 0, 2], vec![9; 520]), 0);
        let merged = eng.merged(1).unwrap();
        assert_eq!(merged.len(), 512);
        assert!(merged.iter().all(|&v| v == 9));
        assert_eq!(eng.snapshot()[0].conflict_channels, 512);
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

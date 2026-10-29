//! 黄金向量测试：读取与前端共用的 `show-eval.json`，逐用例校验求值结果。
//!
//! 同一份 JSON 也被前端 `color.golden.test.ts` 读取，保证 Rust 求值与 TS 预览一致。

use serde_json::{json, Value};
use show_engine::{compile, ShowProject};

const GOLDEN: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../src/features/show-editor/lib/__tests__/golden/show-eval.json"
);

/// 把 `name` 或 `name:默认值` 简写展开成物模型属性。
fn property(spec: &str, channel: usize) -> Value {
    let (name, default) = spec.split_once(':').unwrap_or((spec, "0"));
    json!({
        "name": name,
        "code": format!("{name}{channel}"),
        "function": name,
        "channel": channel,
        "width": 1,
        "bigEndian": true,
        "defaultValue": default.parse::<u16>().expect("默认值应为整数"),
    })
}

/// 由简写用例拼出完整的工程 JSON。
fn build_project(case: &Value) -> Value {
    let models: Vec<Value> = case["models"]
        .as_object()
        .expect("models 应为对象")
        .iter()
        .map(|(id, specs)| {
            let props: Vec<Value> = specs
                .as_array()
                .expect("通道列表应为数组")
                .iter()
                .enumerate()
                .map(|(i, s)| property(s.as_str().expect("通道应为字符串"), i + 1))
                .collect();
            json!({ "id": id, "name": id, "properties": props })
        })
        .collect();

    let fixtures: Vec<Value> = case["fixtures"]
        .as_array()
        .expect("fixtures 应为数组")
        .iter()
        .enumerate()
        .map(|(i, f)| {
            json!({
                "id": format!("f{i}"),
                "name": format!("F{i}"),
                "modelId": f["model"],
                "universe": f["universe"],
                "address": f["address"],
            })
        })
        .collect();

    // 未显式声明轨道时，每台灯具一条轨道。
    let track_specs: Vec<Value> = case["tracks"].as_array().cloned().unwrap_or_else(|| {
        (0..fixtures.len()).map(|i| json!({ "fixture": i })).collect()
    });
    // `fixtures: [..]` 的轨道绑定到一个分组（成员顺序即数组顺序），否则绑定到单个灯具。
    let mut groups: Vec<Value> = Vec::new();
    let tracks: Vec<Value> = track_specs
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let target = if let Some(members) = t["fixtures"].as_array() {
                let ids: Vec<String> = members.iter().map(|m| format!("f{m}")).collect();
                groups.push(json!({ "id": format!("g{i}"), "name": format!("G{i}"), "fixtureIds": ids }));
                json!({ "kind": "group", "id": format!("g{i}") })
            } else {
                json!({ "kind": "fixture", "id": format!("f{}", t["fixture"]) })
            };
            json!({
                "id": format!("t{i}"),
                "target": target,
                "mute": t["mute"].as_bool().unwrap_or(false),
                "solo": t["solo"].as_bool().unwrap_or(false),
            })
        })
        .collect();

    let cues: Vec<Value> = case["cues"]
        .as_array()
        .expect("cues 应为数组")
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let mut cue = json!({
                "kind": "static",
                "id": format!("c{i}"),
                "trackId": format!("t{}", c["track"].as_u64().unwrap_or(0)),
                "startMs": c["startMs"],
                "endMs": c["endMs"],
                "brightness": c["brightness"].as_f64().unwrap_or(100.0),
                "fadeInMs": c["fadeInMs"].as_i64().unwrap_or(0),
                "fadeOutMs": c["fadeOutMs"].as_i64().unwrap_or(0),
                "easing": c["easing"].as_str().unwrap_or("linear"),
                "rgb": c["rgb"],
            });
            if let Some(effect) = c["effect"].as_str() {
                let period = if let Some(beats) = c["beats"].as_f64() {
                    json!({ "kind": "beats", "beats": beats })
                } else {
                    json!({ "kind": "ms", "ms": c["periodMs"].as_f64().expect("特效需要 periodMs 或 beats") })
                };
                if let Some(obj) = cue.as_object_mut() {
                    obj.remove("rgb");
                }
                cue["kind"] = json!("effect");
                cue["effect"] = json!(effect);
                cue["colors"] = c.get("colors").cloned().unwrap_or_else(|| json!([[255, 0, 0]]));
                cue["period"] = period;
                cue["phaseSpread"] = json!(c["phaseSpread"].as_f64().unwrap_or(0.0));
                cue["direction"] = json!(c["direction"].as_i64().unwrap_or(1));
                cue["range"] = c.get("range").cloned().unwrap_or_else(|| json!([0, 100]));
                cue["seed"] = json!(c["seed"].as_u64().unwrap_or(7));
            }
            // 有 `look` 的是外观片段（可带 `spread`），外观与分布原样写入
            if let Some(look) = c.get("look") {
                if let Some(obj) = cue.as_object_mut() {
                    obj.remove("rgb");
                }
                cue["kind"] = json!("look");
                cue["look"] = look.clone();
                if let Some(spread) = c.get("spread") {
                    cue["spread"] = spread.clone();
                }
            }
            cue
        })
        .collect();

    json!({
        "durationMs": 10000,
        "fixtureModels": models,
        "fixtures": fixtures,
        "tracks": tracks,
        "groups": groups,
        "tempo": case.get("tempo").cloned().map(|t| json!({ "bpm": t["bpm"], "offsetMs": 0, "beatsPerBar": 4 })),
        "cues": cues,
        "output": { "gamma": case["gamma"] },
    })
}

#[test]
fn 黄金向量全部通过() {
    let text = std::fs::read_to_string(GOLDEN).expect("应能读取黄金向量文件");
    let golden: Value = serde_json::from_str(&text).expect("黄金向量应是合法 JSON");
    let cases = golden["cases"].as_array().expect("cases 应为数组");
    assert!(!cases.is_empty());

    for case in cases {
        let name = case["name"].as_str().unwrap_or("?");
        let project: ShowProject =
            serde_json::from_value(build_project(case)).unwrap_or_else(|e| panic!("[{name}] 工程无法解析: {e}"));
        let compiled = compile(&project);
        assert!(compiled.warnings().is_empty(), "[{name}] 编译警告: {:?}", compiled.warnings());
        let mut frames = compiled.new_frames();

        for sample in case["samples"].as_array().expect("samples 应为数组") {
            let t = sample["t"].as_i64().expect("t 应为整数");
            let universe = u16::try_from(sample["universe"].as_u64().expect("universe 应为整数")).unwrap();
            compiled.evaluate_into(t, &mut frames);
            let frame = frames
                .frames()
                .iter()
                .find(|f| f.universe == universe)
                .unwrap_or_else(|| panic!("[{name}] 缺少 Universe {universe}"));
            for (ch, want) in sample["expect"].as_object().expect("expect 应为对象") {
                let ch: usize = ch.parse().expect("通道应为整数");
                let want = u8::try_from(want.as_u64().expect("期望值应为整数")).unwrap();
                assert_eq!(
                    frame.data[ch - 1], want,
                    "[{name}] t={t}ms universe={universe} 通道 {ch}"
                );
            }
        }
    }
}

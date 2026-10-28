//! `show-engine` 的 WebAssembly 外壳。
//!
//! 前端（节目编辑器的预览、色带缩略图、色盘的“实际输出”）与后端 30 FPS 输出共用同一份
//! 编译 / 求值 / 混色实现，不再维护 TS 镜像。
//!
//! # 调用约定
//!
//! 不依赖 `wasm-bindgen`，只导出 C ABI 函数，数据经线性内存交换：
//!
//! 1. 宿主调用 [`se_alloc`] 申请缓冲，写入 UTF-8 JSON，再调用 [`se_load`] 得到句柄（`0` 表示失败）；
//! 2. [`se_evaluate`] 在某个时刻求值；之后可读 [`se_preview_ptr`]（每台灯具 3 字节 sRGB，
//!    顺序同 [`se_fixture_ids`]）和 [`se_frame_ptr`]（每个 Universe 512 字节）；
//! 3. 用完调用 [`se_drop`] 释放句柄，[`se_free`] 释放宿主申请的缓冲。
//!
//! 返回变长数据（JSON）的函数把结果放进共享输出缓冲，返回长度，地址由 [`se_out_ptr`] 给出；
//! 输出缓冲在下一次返回变长数据时被覆盖。
//!
//! WebAssembly 是单线程的，状态放在线程局部变量里。

use std::cell::RefCell;

use show_engine::look::NumParam;
use show_engine::{compile, CompiledShow, FrameSet, ShowProject};

/// 一个已加载的节目。
struct Loaded {
    show: CompiledShow,
    frames: FrameSet,
    /// 最近一次求值的预览色（每台灯具 3 字节）。
    preview: Vec<u8>,
}

#[derive(Default)]
struct State {
    slots: Vec<Option<Loaded>>,
    out: Vec<u8>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

/// 引擎版本号（与 crate 版本一致），前端用来确认 `.wasm` 产物与源码同步。
///
/// # Returns
///
/// 版本字符串的长度；内容在输出缓冲里（见 [`se_out_ptr`]）。
#[unsafe(no_mangle)]
pub extern "C" fn se_version() -> u32 {
    put_out(env!("CARGO_PKG_VERSION").as_bytes())
}

/// 在线性内存里申请 `len` 字节，供宿主写入输入数据。
///
/// # Arguments
///
/// * `len` - 字节数。
///
/// # Returns
///
/// 缓冲起始地址；`len` 为 0 时返回一个合法的非空悬垂地址。
#[unsafe(no_mangle)]
pub extern "C" fn se_alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// 释放由 [`se_alloc`] 申请的缓冲。
///
/// # Arguments
///
/// * `ptr` - [`se_alloc`] 返回的地址。
/// * `len` - 申请时的字节数。
///
/// # Safety
///
/// `ptr` 与 `len` 必须来自同一次 [`se_alloc`] 调用，且只能释放一次。
#[unsafe(no_mangle)]
pub unsafe extern "C" fn se_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        // SAFETY: 由调用方保证 `ptr`/`len` 来自 `se_alloc`（容量即 `len`）。
        drop(unsafe { Vec::from_raw_parts(ptr, 0, len) });
    }
}

/// 解析并编译一个工程（前端 `ShowProject` 的 JSON）。
///
/// # Arguments
///
/// * `ptr` - JSON 文本起始地址（由 [`se_alloc`] 申请）。
/// * `len` - JSON 文本字节数。
///
/// # Returns
///
/// 句柄（从 1 开始）；JSON 无法解析时返回 0。
///
/// # Safety
///
/// `ptr..ptr+len` 必须是可读的、已初始化的内存。
#[unsafe(no_mangle)]
pub unsafe extern "C" fn se_load(ptr: *const u8, len: usize) -> u32 {
    // SAFETY: 由调用方保证区间可读。
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    load_bytes(bytes)
}

/// 解析并编译工程（安全版本，供 [`se_load`] 与测试调用）。
///
/// # Arguments
///
/// * `bytes` - 工程 JSON。
///
/// # Returns
///
/// 句柄；解析失败为 0。
#[must_use]
pub fn load_bytes(bytes: &[u8]) -> u32 {
    let Ok(project) = serde_json::from_slice::<ShowProject>(bytes) else {
        return 0;
    };
    let show = compile(&project);
    let frames = show.new_frames();
    let loaded = Loaded { show, frames, preview: Vec::new() };
    STATE.with_borrow_mut(|s| {
        if let Some(i) = s.slots.iter().position(Option::is_none) {
            s.slots[i] = Some(loaded);
            (i + 1) as u32
        } else {
            s.slots.push(Some(loaded));
            s.slots.len() as u32
        }
    })
}

/// 释放一个句柄。
///
/// # Arguments
///
/// * `handle` - [`se_load`] 返回的句柄；无效句柄被忽略。
#[unsafe(no_mangle)]
pub extern "C" fn se_drop(handle: u32) {
    STATE.with_borrow_mut(|s| {
        if let Some(slot) = handle.checked_sub(1).and_then(|i| s.slots.get_mut(i as usize)) {
            *slot = None;
        }
    });
}

/// 已编译灯具的实例编号与编译警告。
///
/// # Arguments
///
/// * `handle` - 句柄。
///
/// # Returns
///
/// JSON `{"fixtures":[...],"universes":[...],"warnings":[...]}` 的长度（在输出缓冲里）；
/// 句柄无效时为 0。
#[unsafe(no_mangle)]
pub extern "C" fn se_fixture_ids(handle: u32) -> u32 {
    let json = with(handle, |l| {
        let ids: Vec<&str> = l.show.fixture_ids().collect();
        serde_json::json!({
            "fixtures": ids,
            "universes": l.show.universes(),
            "warnings": l.show.warnings(),
        })
        .to_string()
    });
    json.map_or(0, |j| put_out(j.as_bytes()))
}

/// 在时刻 `t_ms` 求值：更新 DMX 帧与预览色。
///
/// # Arguments
///
/// * `handle` - 句柄。
/// * `t_ms` - 节目时间（毫秒，非整数时向下取整）。
///
/// # Returns
///
/// 预览色的字节数（灯具数 × 3）；句柄无效时为 0。
#[unsafe(no_mangle)]
pub extern "C" fn se_evaluate(handle: u32, t_ms: f64) -> u32 {
    with_mut(handle, |l| {
        let t = if t_ms.is_finite() { t_ms.floor() as i64 } else { 0 };
        l.show.evaluate_into(t, &mut l.frames);
        l.preview.clear();
        for (_, rgb) in l.show.preview_colors(&l.frames) {
            l.preview.extend_from_slice(&rgb);
        }
        l.preview.len() as u32
    })
    .unwrap_or(0)
}

/// 最近一次求值的预览色（每台灯具 3 字节 sRGB，顺序同 [`se_fixture_ids`]）。
///
/// # Arguments
///
/// * `handle` - 句柄。
///
/// # Returns
///
/// 缓冲地址；句柄无效时为空指针。在下一次求值前有效。
#[unsafe(no_mangle)]
pub extern "C" fn se_preview_ptr(handle: u32) -> *const u8 {
    with(handle, |l| l.preview.as_ptr()).unwrap_or(std::ptr::null())
}

/// 第 `index` 个 Universe（按编号升序）最近一次求值的 512 字节 DMX 数据。
///
/// # Arguments
///
/// * `handle` - 句柄。
/// * `index` - Universe 下标（对应 [`se_fixture_ids`] 返回的 `universes`）。
///
/// # Returns
///
/// 缓冲地址；越界或句柄无效时为空指针。在下一次求值前有效。
#[unsafe(no_mangle)]
pub extern "C" fn se_frame_ptr(handle: u32, index: u32) -> *const u8 {
    with(handle, |l| {
        l.frames
            .frames()
            .get(index as usize)
            .map_or(std::ptr::null(), |f| f.data.as_ptr())
    })
    .unwrap_or(std::ptr::null())
}

/// 在片段内某个时刻对数值参数（固定值 / 关键帧 / 数值曲线）取值，供属性面板显示播放头处的值，
/// 与求值时用的是同一份插值实现。
///
/// # Arguments
///
/// * `ptr` - 参数 JSON（前端 `Param<number>`）起始地址。
/// * `len` - JSON 字节数。
/// * `u_ms` - 相对片段起点的时刻（毫秒）。
/// * `len_ms` - 片段时长（毫秒）。
///
/// # Returns
///
/// 参数值；JSON 无法解析时为 `NaN`。
///
/// # Safety
///
/// `ptr..ptr+len` 必须是可读的、已初始化的内存。
#[unsafe(no_mangle)]
pub unsafe extern "C" fn se_sample_num(ptr: *const u8, len: usize, u_ms: f64, len_ms: f64) -> f64 {
    // SAFETY: 由调用方保证区间可读。
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    sample_num_bytes(bytes, u_ms, len_ms)
}

/// [`se_sample_num`] 的安全版本。
///
/// # Arguments
///
/// * `bytes` - 参数 JSON。
/// * `u_ms` - 相对片段起点的时刻（毫秒）。
/// * `len_ms` - 片段时长（毫秒）。
///
/// # Returns
///
/// 参数值；解析失败为 `NaN`。
#[must_use]
pub fn sample_num_bytes(bytes: &[u8], u_ms: f64, len_ms: f64) -> f64 {
    serde_json::from_slice::<NumParam>(bytes).map_or(f64::NAN, |p| p.sample(u_ms, len_ms))
}

/// 共享输出缓冲的地址（变长结果写在这里）。
///
/// # Returns
///
/// 地址；在下一次写入变长结果前有效。
#[unsafe(no_mangle)]
pub extern "C" fn se_out_ptr() -> *const u8 {
    STATE.with_borrow(|s| s.out.as_ptr())
}

fn put_out(bytes: &[u8]) -> u32 {
    STATE.with_borrow_mut(|s| {
        s.out.clear();
        s.out.extend_from_slice(bytes);
        s.out.len() as u32
    })
}

fn with<T>(handle: u32, f: impl FnOnce(&Loaded) -> T) -> Option<T> {
    STATE.with_borrow(|s| {
        let i = handle.checked_sub(1)? as usize;
        s.slots.get(i)?.as_ref().map(f)
    })
}

fn with_mut<T>(handle: u32, f: impl FnOnce(&mut Loaded) -> T) -> Option<T> {
    STATE.with_borrow_mut(|s| {
        let i = handle.checked_sub(1)? as usize;
        s.slots.get_mut(i)?.as_mut().map(f)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROJECT: &str = r#"{
      "durationMs": 2000,
      "fixtureModels": [{"id":"m","name":"m","properties":[
        {"name":"r","code":"R","function":"red","channel":1,"width":1,"bigEndian":true,"defaultValue":0},
        {"name":"g","code":"G","function":"green","channel":2,"width":1,"bigEndian":true,"defaultValue":0},
        {"name":"b","code":"B","function":"blue","channel":3,"width":1,"bigEndian":true,"defaultValue":0}]}],
      "fixtures": [{"id":"f1","modelId":"m","universe":3,"address":1}],
      "tracks": [{"id":"t","target":{"kind":"fixture","id":"f1"}}],
      "cues": [{"kind":"static","id":"c","trackId":"t","startMs":0,"endMs":1000,"brightness":100,
                "fadeInMs":0,"fadeOutMs":0,"easing":"linear","rgb":[255,0,0]}],
      "output": {"gamma": 1}
    }"#;

    fn out_string(len: u32) -> String {
        STATE.with_borrow(|s| String::from_utf8_lossy(&s.out[..len as usize]).into_owned())
    }

    #[test]
    fn 加载_求值_读取帧与预览色() {
        let h = load_bytes(PROJECT.as_bytes());
        assert!(h > 0);
        let ids = out_string(se_fixture_ids(h));
        assert!(ids.contains("\"f1\"") && ids.contains("\"universes\":[3]"), "{ids}");
        assert_eq!(se_evaluate(h, 500.0), 3);
        let preview = with(h, |l| l.preview.clone()).expect("预览色");
        assert_eq!(preview, vec![255, 0, 0]);
        let frame = with(h, |l| l.frames.frames()[0].data[..3].to_vec()).expect("帧");
        assert_eq!(frame, vec![255, 0, 0]);
        assert!(!se_frame_ptr(h, 0).is_null());
        assert!(se_frame_ptr(h, 1).is_null());
        se_drop(h);
        assert_eq!(se_evaluate(h, 0.0), 0);
        // 释放的槽位被复用
        assert_eq!(load_bytes(PROJECT.as_bytes()), h);
    }

    #[test]
    fn 数值参数取值与引擎插值一致() {
        let keys = br#"{"kind":"keys","keys":[{"tMs":0,"value":0,"curve":"linear"},{"tMs":1000,"value":100,"curve":"easeIn"},{"tMs":2000,"value":0}]}"#;
        assert!((sample_num_bytes(keys, 500.0, 2000.0) - 50.0).abs() < 1e-9);
        assert!((sample_num_bytes(keys, 1500.0, 2000.0) - 75.0).abs() < 1e-9);
        assert!((sample_num_bytes(br#"{"kind":"value","value":42}"#, 0.0, 1.0) - 42.0).abs() < 1e-9);
        let sine = br#"{"kind":"curve","curve":{"shape":"sine","from":0,"to":10,"cycles":1,"phase":0}}"#;
        assert!((sample_num_bytes(sine, 500.0, 1000.0) - 10.0).abs() < 1e-9);
        assert!(sample_num_bytes(b"nope", 0.0, 1.0).is_nan());
    }

    #[test]
    fn 非法工程返回零() {
        assert_eq!(load_bytes(b"{nope"), 0);
        assert_eq!(se_fixture_ids(9999), 0);
        assert!(se_preview_ptr(9999).is_null());
        assert!(out_string(se_version()).starts_with("0."));
    }
}

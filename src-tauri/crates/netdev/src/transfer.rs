//! 流式文件传输：节目文件上传 / 下载与固件 OTA 推送，均带进度回调与取消。
//!
//! 上传与 OTA 直接从磁盘按块读取，不把整个文件载入内存；下载先写临时文件再原子重命名，
//! 取消或失败时清理临时文件。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use std::time::{Duration, Instant};

use futures_util::{StreamExt, TryStreamExt};
use reqwest::header::CONTENT_LENGTH;
use reqwest::{Body, Method};
use serde::Serialize;
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;
use tokio_util::sync::CancellationToken;

use crate::client::DeviceClient;
use crate::error::{NetdevError, Result};
use crate::model::{OtaReceipt, UploadReceipt};
use crate::validate::check_program_file_name;

/// 读文件分块大小。
const CHUNK: usize = 16 * 1024;
/// 进度回调的最小间隔。
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// 传输进度快照。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// 已传输字节数。
    pub done: u64,
    /// 总字节数（下载时服务端未给出长度则为 0）。
    pub total: u64,
    /// 平均速度（字节/秒）。
    pub speed_bps: u64,
}

/// 进度回调类型。
pub type ProgressFn = Arc<dyn Fn(Progress) + Send + Sync>;

/// 进度计量器：累计字节并按间隔节流回调，结束时必定回调一次最终值。
struct Meter {
    total: u64,
    start: Instant,
    on_progress: ProgressFn,
    state: Mutex<(u64, Instant)>,
}

impl Meter {
    fn new(total: u64, on_progress: ProgressFn) -> Arc<Self> {
        let now = Instant::now();
        Arc::new(Self { total, start: now, on_progress, state: Mutex::new((0, now)) })
    }

    fn snapshot(&self, done: u64) -> Progress {
        let secs = self.start.elapsed().as_secs_f64().max(0.001);
        Progress { done, total: self.total, speed_bps: (done as f64 / secs) as u64 }
    }

    /// 累加 `n` 字节；距上次回调不足间隔时跳过。
    fn advance(&self, n: u64) {
        let mut s = self.state.lock();
        s.0 += n;
        if s.1.elapsed() >= PROGRESS_INTERVAL {
            s.1 = Instant::now();
            let p = self.snapshot(s.0);
            drop(s);
            (self.on_progress)(p);
        }
    }

    /// 无条件回调一次当前值。
    fn flush(&self) {
        let done = self.state.lock().0;
        (self.on_progress)(self.snapshot(done));
    }
}

/// 打开本地文件并返回（流式请求体, 总字节数）。
async fn open_body(path: &Path, meter_cb: ProgressFn) -> Result<(Body, u64, Arc<Meter>)> {
    let file = tokio::fs::File::open(path).await?;
    let len = file.metadata().await?.len();
    if len == 0 {
        return Err(NetdevError::Invalid("文件为空".into()));
    }
    let meter = Meter::new(len, meter_cb);
    let m = Arc::clone(&meter);
    let stream = ReaderStream::with_capacity(file, CHUNK).inspect_ok(move |chunk| m.advance(chunk.len() as u64));
    Ok((Body::wrap_stream(stream), len, meter))
}

/// 在取消令牌与请求之间竞争；取消优先。
async fn cancellable<T>(
    cancel: &CancellationToken,
    fut: impl std::future::Future<Output = Result<T>>,
) -> Result<T> {
    tokio::select! {
        biased;
        () = cancel.cancelled() => Err(NetdevError::Cancelled),
        r = fut => r,
    }
}

impl DeviceClient {
    /// 上传 / 覆盖节目文件（`PUT /files/{name}`），从磁盘流式读取。
    ///
    /// # Arguments
    ///
    /// * `name` - 设备上的文件名，须符合固件规则（`.artrec`、≤128 字节、无路径分隔符）。
    /// * `path` - 本地文件路径。
    /// * `on_progress` - 进度回调（约每 100 毫秒一次，结束时必有最终值）。
    /// * `cancel` - 取消令牌；触发后立即中止请求。
    ///
    /// # Returns
    ///
    /// 设备回执，含自动分配的节目号。
    ///
    /// # Errors
    ///
    /// 文件名非法、本地读取失败、被取消，或设备返回错误（422 校验失败 / 507 空间不足 / 409 忙）时返回 [`NetdevError`]。
    pub async fn upload_file(
        &self,
        name: &str,
        path: &Path,
        on_progress: ProgressFn,
        cancel: &CancellationToken,
    ) -> Result<UploadReceipt> {
        check_program_file_name(name)?;
        let (body, len, meter) = open_body(path, on_progress).await?;
        let rb = self
            .request(Method::PUT, &Self::file_path(name))
            .header(CONTENT_LENGTH, len)
            .body(body);
        let text = cancellable(cancel, async {
            let resp = Self::check(rb.send().await?).await?;
            Ok(resp.text().await?)
        })
        .await?;
        meter.flush();
        serde_json::from_str(&text).map_err(|e| NetdevError::BadResponse(e.to_string()))
    }

    /// 推送固件并触发 OTA（`POST /api/ota`，请求体为裸字节）。
    ///
    /// 成功时设备会在约 0.5 秒后重启。
    ///
    /// # Arguments
    ///
    /// * `path` - 本地固件 `.bin` 路径。
    /// * `on_progress` - 进度回调。
    /// * `cancel` - 取消令牌。
    ///
    /// # Returns
    ///
    /// 设备回执，含新固件版本与是否重启。
    ///
    /// # Errors
    ///
    /// 本地读取失败、被取消，或设备拒绝（如 507 / 422 / 401）时返回 [`NetdevError`]。
    pub async fn ota_upload(
        &self,
        path: &Path,
        on_progress: ProgressFn,
        cancel: &CancellationToken,
    ) -> Result<OtaReceipt> {
        let (body, len, meter) = open_body(path, on_progress).await?;
        let rb = self.request(Method::POST, "/api/ota").header(CONTENT_LENGTH, len).body(body);
        let text = cancellable(cancel, async {
            let resp = Self::check(rb.send().await?).await?;
            Ok(resp.text().await?)
        })
        .await?;
        meter.flush();
        serde_json::from_str(&text).map_err(|e| NetdevError::BadResponse(e.to_string()))
    }

    /// 下载文件到本地路径（`GET /files/{name}`），流式写盘。
    ///
    /// # Arguments
    ///
    /// * `name` - 设备上的文件名。
    /// * `dest` - 本地保存路径（父目录须已存在，已有同名文件会被替换）。
    /// * `on_progress` - 进度回调。
    /// * `cancel` - 取消令牌。
    ///
    /// # Errors
    ///
    /// 文件名非法、设备返回错误、写盘失败或被取消时返回 [`NetdevError`]；失败时不留临时文件。
    pub async fn download_file(
        &self,
        name: &str,
        dest: &Path,
        on_progress: ProgressFn,
        cancel: &CancellationToken,
    ) -> Result<()> {
        check_program_file_name(name)?;
        let tmp = temp_path(dest);
        let result = self.download_to(name, &tmp, on_progress, cancel).await;
        match result {
            Ok(()) => tokio::fs::rename(&tmp, dest).await.map_err(|e| {
                let _ = std::fs::remove_file(&tmp);
                NetdevError::from(e)
            }),
            Err(e) => {
                let _ = tokio::fs::remove_file(&tmp).await;
                Err(e)
            }
        }
    }

    async fn download_to(
        &self,
        name: &str,
        tmp: &Path,
        on_progress: ProgressFn,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let resp = cancellable(cancel, async {
            Self::check(self.request(Method::GET, &Self::file_path(name)).send().await?).await
        })
        .await?;
        let meter = Meter::new(resp.content_length().unwrap_or(0), on_progress);
        let mut file = tokio::fs::File::create(tmp).await?;
        let mut stream = resp.bytes_stream();
        loop {
            let next = cancellable(cancel, async { stream.next().await.transpose().map_err(NetdevError::from) }).await?;
            let Some(chunk) = next else { break };
            file.write_all(&chunk).await?;
            meter.advance(chunk.len() as u64);
        }
        file.flush().await?;
        meter.flush();
        Ok(())
    }
}

/// 下载临时文件路径：目标路径加 `.download` 后缀。
fn temp_path(dest: &Path) -> PathBuf {
    let mut s = dest.as_os_str().to_owned();
    s.push(".download");
    PathBuf::from(s)
}

/// 进行中的传输登记表：按前端提供的传输 id 保存取消令牌，供 `cancel` 中止。
#[derive(Debug, Default)]
pub struct TransferTable {
    map: Mutex<std::collections::HashMap<String, CancellationToken>>,
}

/// 传输登记的守卫：持有期间传输可被取消，析构时自动注销。
#[derive(Debug)]
pub struct TransferGuard {
    table: Arc<TransferTable>,
    id: String,
    token: CancellationToken,
}

impl TransferGuard {
    /// 本次传输的取消令牌。
    #[must_use]
    pub fn token(&self) -> &CancellationToken {
        &self.token
    }
}

impl Drop for TransferGuard {
    fn drop(&mut self) {
        self.table.map.lock().remove(&self.id);
    }
}

impl TransferTable {
    /// 登记一次传输。
    ///
    /// # Arguments
    ///
    /// * `table` - 登记表（`Arc`，守卫析构时需要回写）。
    /// * `id` - 前端生成的传输 id，必须非空且当前未被占用。
    ///
    /// # Returns
    ///
    /// 持有取消令牌的守卫。
    ///
    /// # Errors
    ///
    /// id 为空或已被另一个进行中的传输占用时返回 [`NetdevError::Invalid`]。
    pub fn begin(table: &Arc<Self>, id: &str) -> Result<TransferGuard> {
        if id.is_empty() {
            return Err(NetdevError::Invalid("传输 id 不能为空".into()));
        }
        let mut map = table.map.lock();
        if map.contains_key(id) {
            return Err(NetdevError::Invalid("传输 id 重复".into()));
        }
        let token = CancellationToken::new();
        map.insert(id.to_string(), token.clone());
        Ok(TransferGuard { table: Arc::clone(table), id: id.to_string(), token })
    }

    /// 取消一次进行中的传输。
    ///
    /// # Arguments
    ///
    /// * `id` - 传输 id。
    ///
    /// # Returns
    ///
    /// 找到并触发取消返回 `true`；传输已结束或不存在返回 `false`。
    pub fn cancel(&self, id: &str) -> bool {
        let map = self.map.lock();
        map.get(id).is_some_and(|t| {
            t.cancel();
            true
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::matchers::{header, method, path as url_path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn client_for(server: &MockServer) -> DeviceClient {
        let a = server.address();
        DeviceClient::new(&a.ip().to_string(), a.port(), None).unwrap()
    }

    fn collector() -> (ProgressFn, Arc<Mutex<Vec<Progress>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let s = Arc::clone(&seen);
        (Arc::new(move |p| s.lock().push(p)), seen)
    }

    fn write_tmp(dir: &tempfile::TempDir, name: &str, len: usize) -> PathBuf {
        let p = dir.path().join(name);
        let data: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
        std::fs::write(&p, data).unwrap();
        p
    }

    #[test]
    fn transfer_table_lifecycle() {
        let table = Arc::new(TransferTable::default());
        assert!(TransferTable::begin(&table, "").is_err());
        let g = TransferTable::begin(&table, "t1").unwrap();
        assert!(TransferTable::begin(&table, "t1").is_err());
        assert!(!g.token().is_cancelled());
        assert!(table.cancel("t1"));
        assert!(g.token().is_cancelled());
        assert!(!table.cancel("other"));
        drop(g);
        assert!(!table.cancel("t1"));
        assert!(TransferTable::begin(&table, "t1").is_ok());
    }

    #[tokio::test]
    async fn upload_streams_body_with_length_and_reports_progress() {
        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(url_path("/files/show.artrec"))
            .and(header("content-length", "300000"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "name": "show.artrec", "size": 300_000, "program": 5 })))
            .expect(1)
            .mount(&server)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let file = write_tmp(&dir, "src.bin", 300_000);
        let (cb, seen) = collector();
        let r = client_for(&server).upload_file("show.artrec", &file, cb, &CancellationToken::new()).await.unwrap();
        assert_eq!(r.program, Some(5));

        let reqs = server.received_requests().await.unwrap();
        assert_eq!(reqs[0].body, std::fs::read(&file).unwrap());

        let seen = seen.lock();
        let last = seen.last().unwrap();
        assert_eq!((last.done, last.total), (300_000, 300_000));
        assert!(seen.windows(2).all(|w| w[0].done <= w[1].done));
    }

    #[tokio::test]
    async fn upload_rejects_bad_name_and_empty_file_without_request() {
        let server = MockServer::start().await;
        let dir = tempfile::tempdir().unwrap();
        let empty = dir.path().join("e.bin");
        std::fs::write(&empty, b"").unwrap();
        let c = client_for(&server);
        let (cb, _) = collector();
        assert!(matches!(c.upload_file("x.txt", &empty, Arc::clone(&cb), &CancellationToken::new()).await, Err(NetdevError::Invalid(_))));
        assert!(matches!(c.upload_file("x.artrec", &empty, cb, &CancellationToken::new()).await, Err(NetdevError::Invalid(_))));
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn upload_maps_device_errors() {
        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .respond_with(ResponseTemplate::new(422).set_body_json(json!({ "error": "bad_file" })))
            .mount(&server)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let file = write_tmp(&dir, "s.bin", 100);
        let (cb, _) = collector();
        let r = client_for(&server).upload_file("a.artrec", &file, cb, &CancellationToken::new()).await;
        assert!(matches!(r, Err(NetdevError::BadFile)));
    }

    #[tokio::test]
    async fn upload_can_be_cancelled() {
        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(5)).set_body_json(json!({})))
            .mount(&server)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let file = write_tmp(&dir, "s.bin", 1000);
        let cancel = CancellationToken::new();
        let c2 = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            c2.cancel();
        });
        let (cb, _) = collector();
        let started = Instant::now();
        let r = client_for(&server).upload_file("a.artrec", &file, cb, &cancel).await;
        assert!(matches!(r, Err(NetdevError::Cancelled)));
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[tokio::test]
    async fn ota_posts_raw_bytes() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(url_path("/api/ota"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "ok": true, "newVersion": "2.0.0", "rebooting": true })))
            .expect(1)
            .mount(&server)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let file = write_tmp(&dir, "fw.bin", 50_000);
        let (cb, seen) = collector();
        let r = client_for(&server).ota_upload(&file, cb, &CancellationToken::new()).await.unwrap();
        assert_eq!(r.new_version, "2.0.0");
        assert!(r.rebooting);
        assert_eq!(server.received_requests().await.unwrap()[0].body.len(), 50_000);
        assert_eq!(seen.lock().last().unwrap().done, 50_000);
    }

    #[tokio::test]
    async fn download_writes_file_and_leaves_no_temp() {
        let server = MockServer::start().await;
        let payload: Vec<u8> = (0..70_000).map(|i| (i % 199) as u8).collect();
        Mock::given(method("GET"))
            .and(url_path("/files/a%20b.artrec"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(payload.clone()))
            .mount(&server)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("out.artrec");
        let (cb, seen) = collector();
        client_for(&server).download_file("a b.artrec", &dest, cb, &CancellationToken::new()).await.unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), payload);
        assert!(!temp_path(&dest).exists());
        assert_eq!(seen.lock().last().unwrap().done, 70_000);
    }

    #[tokio::test]
    async fn download_error_and_cancel_leave_nothing() {
        let server = MockServer::start().await;
        Mock::given(url_path("/files/missing.artrec"))
            .respond_with(ResponseTemplate::new(404).set_body_json(json!({ "error": "not_found" })))
            .mount(&server)
            .await;
        Mock::given(url_path("/files/slow.artrec"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(5)).set_body_bytes(vec![1u8; 10]))
            .mount(&server)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("o.artrec");
        let c = client_for(&server);
        let (cb, _) = collector();
        let r = c.download_file("missing.artrec", &dest, Arc::clone(&cb), &CancellationToken::new()).await;
        assert!(matches!(r, Err(NetdevError::NotFound)));

        let cancel = CancellationToken::new();
        let c2 = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            c2.cancel();
        });
        let r = c.download_file("slow.artrec", &dest, cb, &cancel).await;
        assert!(matches!(r, Err(NetdevError::Cancelled)));
        assert!(!dest.exists() && !temp_path(&dest).exists());
    }
}

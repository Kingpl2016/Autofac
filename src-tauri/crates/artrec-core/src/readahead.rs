//! 顺序预读数据源 [`ReadAhead`]：把"按帧号顺序扫描"时密集的小块 `seek + read`
//! 合并成少量大块读取。
//!
//! [`crate::ArtRecReader`] 每读一个 Chunk 都会 `seek(SeekFrom::Start(off))` 再 `read_exact`。
//! 直接用 `File` 时这是两次系统调用；`std::io::BufReader` 的 `seek` 又总是丢弃缓冲。
//! `ReadAhead` 在 `seek` 目标落在当前缓冲窗口内时只移动游标、不触发系统调用，
//! 越界才真正 `seek` 并在下次读取时重新填充窗口。适合概览、曲线这类顺序扫描：
//!
//! ```no_run
//! # fn main() -> artrec_core::Result<()> {
//! use std::fs::File;
//! use std::path::Path;
//!
//! use artrec_core::{ArtRecReader, ReadAhead};
//!
//! let path = Path::new("show.artrec");
//! let reader = ArtRecReader::open_file(path)?;
//! let scan = reader.with_source(ReadAhead::new(File::open(path)?, 1 << 20))?;
//! let mut raw = Vec::new();
//! for i in 0..scan.index().len() {
//!     let _hdr = scan.read_chunk_into(i, &mut raw)?;
//! }
//! # Ok(())
//! # }
//! ```

use std::io::{self, Read, Seek, SeekFrom};

/// 默认窗口大小：1 MiB。
pub const DEFAULT_READ_AHEAD: usize = 1 << 20;

/// 带可配置窗口的顺序预读数据源，实现 `Read + Seek`。
///
/// 内部不变量：已知窗口起点（`base` 为 `Some`）时，底层数据源的物理位置恰为
/// `base + filled`；逻辑位置为 `base + pos`（`pos <= filled`）。`base` 为 `None` 表示
/// 尚未确定绝对位置，此时逻辑位置等于底层数据源的当前位置。
#[derive(Debug)]
pub struct ReadAhead<R> {
    /// 底层数据源。
    inner: R,
    /// 窗口缓冲（容量即窗口大小）。
    buf: Box<[u8]>,
    /// 窗口内有效字节数。
    filled: usize,
    /// 窗口内的读游标（`<= filled`）。
    pos: usize,
    /// 窗口起点在底层数据源中的绝对偏移；`None` 表示尚未确定。
    base: Option<u64>,
}

impl<R: Read + Seek> ReadAhead<R> {
    /// 以指定窗口大小包装数据源。
    ///
    /// 不触发任何 IO；逻辑起始位置为 `inner` 的当前位置。
    ///
    /// # Arguments
    ///
    /// * `inner` - 底层数据源（通常是 `File`）。
    /// * `capacity` - 窗口字节数（如 `1 << 20`）；为 `0` 时退化为直通（每次读写都落到底层）。
    ///
    /// # Returns
    ///
    /// 窗口为空、尚未读取任何数据的预读数据源。
    #[must_use]
    pub fn new(inner: R, capacity: usize) -> Self {
        Self {
            inner,
            buf: vec![0u8; capacity].into_boxed_slice(),
            filled: 0,
            pos: 0,
            base: None,
        }
    }

    /// 以默认窗口（[`DEFAULT_READ_AHEAD`]，1 MiB）包装数据源。
    ///
    /// # Arguments
    ///
    /// * `inner` - 底层数据源。
    ///
    /// # Returns
    ///
    /// 窗口为 1 MiB 的预读数据源。
    #[must_use]
    pub fn with_default_capacity(inner: R) -> Self {
        Self::new(inner, DEFAULT_READ_AHEAD)
    }

    /// 窗口字节数。
    ///
    /// # Returns
    ///
    /// 构造时指定的窗口大小。
    #[must_use]
    pub fn capacity(&self) -> usize {
        self.buf.len()
    }

    /// 底层数据源的只读引用。
    ///
    /// # Returns
    ///
    /// 被包装的数据源（其物理位置可能领先于逻辑位置）。
    #[must_use]
    pub fn get_ref(&self) -> &R {
        &self.inner
    }

    /// 取回底层数据源，丢弃窗口中尚未消费的数据。
    ///
    /// # Returns
    ///
    /// 被包装的数据源（其物理位置可能领先于逻辑位置）。
    #[must_use]
    pub fn into_inner(self) -> R {
        self.inner
    }

    /// 清空窗口并把绝对位置记为 `at`（底层数据源此刻须恰好位于 `at`）。
    ///
    /// # Arguments
    ///
    /// * `at` - 底层数据源当前的绝对位置；`None` 表示未知（逻辑位置即底层当前位置）。
    fn reset_window(&mut self, at: Option<u64>) {
        self.base = at;
        self.filled = 0;
        self.pos = 0;
    }

    /// 窗口已读完时，从底层数据源的当前物理位置重新填充窗口。
    ///
    /// # Errors
    ///
    /// 底层读取或定位失败时返回对应 IO 错误。
    fn refill(&mut self) -> io::Result<()> {
        let start = match self.base {
            Some(b) => b + self.filled as u64,
            None => self.inner.stream_position()?,
        };
        let n = loop {
            match self.inner.read(&mut self.buf) {
                Ok(n) => break n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => return Err(e),
            }
        };
        self.base = Some(start);
        self.filled = n;
        self.pos = 0;
        Ok(())
    }
}

impl<R: Read + Seek> Read for ReadAhead<R> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if out.is_empty() {
            return Ok(0);
        }
        if self.pos == self.filled {
            // 窗口已读完：请求不小于窗口时直接读底层（此时物理位置 == 逻辑位置），省一次拷贝
            if out.len() >= self.buf.len() {
                let n = self.inner.read(out)?;
                let next = self.base.map(|b| b + self.filled as u64 + n as u64);
                self.reset_window(next);
                return Ok(n);
            }
            self.refill()?;
        }
        let n = out.len().min(self.filled - self.pos);
        out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

impl<R: Read + Seek> Seek for ReadAhead<R> {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        // 先把目标换算为绝对偏移；无法换算（相对末尾，或尚未确定窗口位置）时直接交给底层
        let target = match (to, self.base) {
            (SeekFrom::Start(off), _) => Some(off),
            (SeekFrom::Current(delta), Some(base)) => {
                let cur = base + self.pos as u64;
                Some(cur.checked_add_signed(delta).ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidInput, "seek 到负数或溢出的位置")
                })?)
            }
            (SeekFrom::Current(_) | SeekFrom::End(_), _) => None,
        };
        if let (Some(t), Some(base)) = (target, self.base) {
            // 落在当前窗口内（含窗口末尾）：只移动游标，不触发系统调用
            if t >= base && t - base <= self.filled as u64 {
                self.pos = (t - base) as usize;
                return Ok(t);
            }
        }
        let at = match target {
            Some(t) => self.inner.seek(SeekFrom::Start(t))?,
            None => self.inner.seek(to)?,
        };
        self.reset_window(Some(at));
        Ok(at)
    }
}

#[cfg(test)]
mod tests {
    use std::io::{self, Cursor, Read, Seek, SeekFrom};

    use super::ReadAhead;

    /// 统计底层 `read` / `seek` 调用次数的包装，模拟系统调用计数。
    struct Counting<R> {
        inner: R,
        reads: usize,
        seeks: usize,
    }

    impl<R> Counting<R> {
        fn new(inner: R) -> Self {
            Self {
                inner,
                reads: 0,
                seeks: 0,
            }
        }
    }

    impl<R: Read> Read for Counting<R> {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.reads += 1;
            self.inner.read(buf)
        }
    }

    impl<R: Seek> Seek for Counting<R> {
        fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
            self.seeks += 1;
            self.inner.seek(pos)
        }
    }

    fn data(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i * 13 % 256) as u8).collect()
    }

    fn counting(len: usize, cap: usize) -> ReadAhead<Counting<Cursor<Vec<u8>>>> {
        ReadAhead::new(Counting::new(Cursor::new(data(len))), cap)
    }

    fn read_n<R: Read>(r: &mut R, n: usize) -> Vec<u8> {
        let mut v = vec![0u8; n];
        r.read_exact(&mut v).unwrap();
        v
    }

    #[test]
    fn seek_inside_window_does_not_touch_inner() {
        let d = data(1000);
        let mut r = counting(1000, 64);
        assert_eq!(read_n(&mut r, 10), &d[0..10]);
        let (reads, seeks) = (r.get_ref().reads, r.get_ref().seeks);
        // 向后、向前、Current 相对、窗口末尾：全部只移动游标
        for (to, want) in [
            (SeekFrom::Start(40), 40u64),
            (SeekFrom::Start(3), 3),
            (SeekFrom::Current(5), 8),
            (SeekFrom::Current(-8), 0),
            (SeekFrom::Start(64), 64),
        ] {
            assert_eq!(r.seek(to).unwrap(), want);
            assert_eq!(r.stream_position().unwrap(), want);
        }
        r.seek(SeekFrom::Start(20)).unwrap();
        assert_eq!(read_n(&mut r, 30), &d[20..50]);
        assert_eq!(
            (r.get_ref().reads, r.get_ref().seeks),
            (reads, seeks),
            "窗口内不应触发底层调用"
        );
    }

    #[test]
    fn seek_outside_window_seeks_inner_once() {
        let d = data(1000);
        let mut r = counting(1000, 64);
        assert_eq!(read_n(&mut r, 8), &d[0..8]);
        let seeks = r.get_ref().seeks;
        assert_eq!(r.seek(SeekFrom::Start(500)).unwrap(), 500);
        assert_eq!(r.get_ref().seeks, seeks + 1);
        assert_eq!(read_n(&mut r, 16), &d[500..516]);
        // 退回窗口之前
        assert_eq!(r.seek(SeekFrom::Start(100)).unwrap(), 100);
        assert_eq!(r.get_ref().seeks, seeks + 2);
        assert_eq!(read_n(&mut r, 4), &d[100..104]);
        // 相对末尾：总是交给底层
        assert_eq!(r.seek(SeekFrom::End(-10)).unwrap(), 990);
        assert_eq!(read_n(&mut r, 10), &d[990..1000]);
    }

    #[test]
    fn sequential_reads_span_windows() {
        let d = data(1000);
        let mut r = counting(1000, 64);
        // 跨多个窗口的一次 read_exact，以及跨窗口边界的小块读
        r.seek(SeekFrom::Start(10)).unwrap();
        assert_eq!(read_n(&mut r, 200), &d[10..210]);
        assert_eq!(read_n(&mut r, 7), &d[210..217]);
        // 模拟读取器：每块先 seek 到"紧接上一块"的位置再读，整段只应有极少底层调用
        let mut r = counting(1000, 64);
        let mut off = 0usize;
        for len in [8usize, 30, 5, 21, 64, 3, 100, 1] {
            r.seek(SeekFrom::Start(off as u64)).unwrap();
            assert_eq!(read_n(&mut r, len), &d[off..off + len]);
            off += len;
        }
        assert!(
            r.get_ref().reads <= off / 64 + 3,
            "reads={}",
            r.get_ref().reads
        );
        assert_eq!(
            r.get_ref().seeks,
            1,
            "只有首次 seek（未确定窗口位置）落到底层"
        );
    }

    #[test]
    fn large_reads_bypass_window() {
        let d = data(1000);
        let mut r = counting(1000, 16);
        assert_eq!(read_n(&mut r, 3), &d[0..3]);
        assert_eq!(read_n(&mut r, 13), &d[3..16]);
        assert_eq!(read_n(&mut r, 100), &d[16..116]);
        assert_eq!(r.stream_position().unwrap(), 116);
        assert_eq!(read_n(&mut r, 5), &d[116..121]);
        r.seek(SeekFrom::Current(-1)).unwrap();
        assert_eq!(read_n(&mut r, 2), &d[120..122]);
    }

    #[test]
    fn eof_behaviour() {
        let d = data(100);
        let mut r = counting(100, 32);
        r.seek(SeekFrom::Start(97)).unwrap();
        let mut buf = [0u8; 10];
        assert_eq!(r.read(&mut buf).unwrap(), 3);
        assert_eq!(&buf[..3], &d[97..100]);
        assert_eq!(r.read(&mut buf).unwrap(), 0);
        assert_eq!(r.read(&mut buf).unwrap(), 0);
        // read_exact 越过末尾报 UnexpectedEof
        r.seek(SeekFrom::Start(95)).unwrap();
        let err = r.read_exact(&mut buf).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::UnexpectedEof);
        // seek 到末尾之后：允许，读到 0 字节
        assert_eq!(r.seek(SeekFrom::Start(500)).unwrap(), 500);
        assert_eq!(r.read(&mut buf).unwrap(), 0);
        // 末尾之后再回到有效区
        r.seek(SeekFrom::Start(0)).unwrap();
        assert_eq!(read_n(&mut r, 4), &d[0..4]);
        // 负数位置报错
        assert_eq!(
            r.seek(SeekFrom::Current(-100)).unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
    }

    #[test]
    fn starts_at_inner_position_and_supports_zero_capacity() {
        let d = data(300);
        let mut c = Cursor::new(d.clone());
        c.seek(SeekFrom::Start(50)).unwrap();
        let mut r = ReadAhead::new(c, 32);
        assert_eq!(read_n(&mut r, 10), &d[50..60]);
        assert_eq!(r.stream_position().unwrap(), 60);
        r.seek(SeekFrom::Current(-5)).unwrap();
        assert_eq!(read_n(&mut r, 5), &d[55..60]);

        let mut z = ReadAhead::new(Cursor::new(d.clone()), 0);
        z.seek(SeekFrom::Start(7)).unwrap();
        assert_eq!(read_n(&mut z, 20), &d[7..27]);
        assert_eq!(z.stream_position().unwrap(), 27);
    }

    #[test]
    fn random_ops_match_plain_cursor() {
        let bytes = data(5000);
        let mut want = Cursor::new(bytes.clone());
        let mut got = ReadAhead::new(Cursor::new(bytes), 256);
        let mut state = 0x2545_F491_4F6C_DD1Du64;
        let mut next = move |bound: u64| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state % bound
        };
        for _ in 0..5000 {
            match next(4) {
                0 => {
                    let to = SeekFrom::Start(next(5200));
                    assert_eq!(got.seek(to).unwrap(), want.seek(to).unwrap());
                }
                1 => {
                    let delta = next(600).cast_signed() - 300;
                    let cur = want.stream_position().unwrap();
                    if cur.checked_add_signed(delta).is_some() {
                        let to = SeekFrom::Current(delta);
                        assert_eq!(got.seek(to).unwrap(), want.seek(to).unwrap());
                    }
                }
                _ => {
                    let mut expect_buf = vec![0u8; next(400) as usize];
                    let mut got_buf = expect_buf.clone();
                    let want_len = want.read(&mut expect_buf).unwrap();
                    // ReadAhead 单次 read 可能更短：补读到与 Cursor 相同的字节数再比较
                    let mut done = 0;
                    while done < want_len {
                        let step = got.read(&mut got_buf[done..want_len]).unwrap();
                        assert!(step > 0);
                        done += step;
                    }
                    assert_eq!(&expect_buf[..want_len], &got_buf[..want_len]);
                }
            }
            assert_eq!(
                got.stream_position().unwrap(),
                want.stream_position().unwrap()
            );
        }
    }
}

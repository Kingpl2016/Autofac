"""Art-Net Studio 桌面端打包脚本（Tauri / src-tauri）。

产物（写入仓库根目录 ``release/``）：

* 安装版：NSIS 安装包 ``*_setup.exe``（当前用户安装，无需管理员权限）。
* 免安装版：``*_portable.zip``，解压后直接运行 ``art-net-studio.exe``。

构建变体（``--variant``）：

* ``modern``（默认）：stable 工具链 + 宿主目标，使用系统 Evergreen WebView2，面向 Win10 / Win11。
* ``win7``：nightly 工具链 + ``x86_64-win7-windows-msvc`` + ``-Z build-std``，
  静态链接 CRT，并随包携带 WebView2 固定版本运行时 109（最后一个支持 Win7 的版本），
  可运行于 Win7 SP1 ~ Win11。
* ``all``：依次构建上述两个变体。

产物类型（``--format``）可分开执行：``installer`` 只出安装版，``portable`` 只出免安装版，``all`` 两者都出。
WebView2（``--webview2``）：``bundled`` 随包携带固定版运行时（离线可用），``system`` 使用系统已安装的，
``both`` 两种都出；默认 win7 变体携带、modern 变体用系统的。文件名带 ``_with-webview2`` / ``_no-webview2``。
携带/不携带会编译成不同的 exe（运行时路径写在编译期配置里），因此 ``both`` 会各编译一次。

用法示例::

    python scripts/build_tauri.py                       # 现代 Windows：安装版 + 免安装版（用系统 WebView2）
    python scripts/build_tauri.py --format installer    # 只出安装版
    python scripts/build_tauri.py --format portable --webview2 both   # 免安装版：带 / 不带 WebView2 各一份
    python scripts/build_tauri.py --variant win7        # Win7 兼容：安装版 + 免安装版（带 WebView2 109）
    python scripts/build_tauri.py --variant all --format portable
    python scripts/build_tauri.py --variant win7 --webview2-cab D:\\dl\\xxx.x64.cab
    python scripts/build_tauri.py --dry-run             # 只打印将要执行的步骤

只依赖 Python 标准库（需要 3.11+），另需 Node.js / npm、Rust、``expand.exe``（Windows 自带，仅 win7 变体用）。

注意：Tauri 自 2.12 起已官方放弃 Win7，``win7`` 变体属于"尽力而为"。
构建结束后脚本会扫描 exe 的导入表，列出已知的 Win8+ 专有 API 作为预警，但这不能代替在真实 Win7 上的实测。
当前锁定的 tauri 2.12.x 依赖链（tao / wry / webview2-com → windows 0.62）会静态导入 Win7 没有的
``combase.dll`` 与 ``api-ms-win-core-winrt-error-l1-1-0.dll``，此时 exe 在 Win7 上无法启动，
需要把 tauri 系列依赖降到仍兼容 Win7 的旧版本后再打包（预警会指出这一点）。

实现备注：Tauri CLI 的 ``--target`` 会按 rustup 已安装目标校验，而 win7 目标是 Tier 3（无预编译 std），
因此 win7 变体改用 ``CARGO_BUILD_TARGET`` + ``CARGO_UNSTABLE_BUILD_STD`` 环境变量。
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import struct
import subprocess
import sys
import time
import tomllib
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TAURI_DIR = ROOT / "src-tauri"
TAURI_CONF = TAURI_DIR / "tauri.conf.json"
CARGO_TOML = TAURI_DIR / "Cargo.toml"
OUT_DIR = ROOT / "release"
CACHE_DIR = Path(__file__).resolve().parent / ".cache"

# WebView2 固定版本运行时：109 是最后一个支持 Win7 / 8 / 8.1 的版本。
# 微软官网只保留最新两个版本，这里使用社区归档（可用 --webview2-url / --webview2-cab 替换）。
WEBVIEW2_VERSION = "109.0.1518.78"
WEBVIEW2_URL_TEMPLATE = (
    "https://github.com/westinyang/WebView2RuntimeArchive/releases/download/"
    "{ver}/Microsoft.WebView2.FixedVersionRuntime.{ver}.{arch}.cab"
)
WEBVIEW2_MAX_MAJOR = 109

# arch -> Rust 的 win7 目标三元组（Tier 3，无预编译 std，必须 nightly + build-std）
WIN7_TRIPLES = {
    "x64": "x86_64-win7-windows-msvc",
    "x86": "i686-win7-windows-msvc",
}

# 已知 Win8 及以上才有的导入符号（非完备清单，仅做预警）。
NON_WIN7_SYMBOLS = {
    "GetSystemTimePreciseAsFileTime": "Win8",
    "WaitOnAddress": "Win8",
    "WakeByAddressSingle": "Win8",
    "WakeByAddressAll": "Win8",
    "ProcessPrng": "Win10（getrandom 未走 win7 分支）",
    "SetThreadDescription": "Win10 1607",
    "GetThreadDescription": "Win10 1607",
    "GetPackagesByPackageFamily": "Win8",
    "GetCurrentPackageFullName": "Win8",
    "GetCurrentApplicationUserModelId": "Win8",
    "SetProcessMitigationPolicy": "Win8",
    "GetProcessMitigationPolicy": "Win8",
    "CreateFile2": "Win8",
    "PathCchCanonicalizeEx": "Win8",
    "GetOverlappedResultEx": "Win8",
    "DiscardVirtualMemory": "Win8.1",
    "VirtualAlloc2": "Win10 1803",
    "MapViewOfFile3": "Win10 1803",
    "GetDpiForWindow": "Win10 1607",
    "GetDpiForSystem": "Win10 1607",
    "SetProcessDpiAwarenessContext": "Win10 1703",
    "GetCurrentThreadStackLimits": "Win8",
    "NtWaitForAlertByThreadId": "Win8",
}
NON_WIN7_DLL_PREFIXES = (
    "api-ms-win-core-synch-l1-2",
    "api-ms-win-core-winrt-",
    "combase.dll",
)


# --------------------------------------------------------------------------- 工具函数


def log(msg: str) -> None:
    print(f"[build] {msg}", flush=True)


def fail(msg: str) -> "None":
    print(f"[build] 错误：{msg}", file=sys.stderr, flush=True)
    sys.exit(1)


def fmt_size(n: int) -> str:
    return f"{n / 1024 / 1024:.1f} MiB"


def run(
    cmd: list[str],
    *,
    cwd: Path = ROOT,
    env: dict[str, str] | None = None,
    dry_run: bool = False,
    capture: bool = False,
) -> subprocess.CompletedProcess[str] | None:
    """执行外部命令，失败时直接退出。"""
    shown = " ".join(f'"{c}"' if " " in c else c for c in cmd)
    print(f"$ {shown}", flush=True)
    if dry_run:
        return None
    merged = {**os.environ, **(env or {})}
    try:
        proc = subprocess.run(
            cmd,
            cwd=cwd,
            env=merged,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=capture,
        )
    except FileNotFoundError:
        fail(f"找不到命令：{cmd[0]}")
    if proc.returncode != 0:
        if capture:
            sys.stderr.write((proc.stdout or "") + (proc.stderr or ""))
        fail(f"命令失败（退出码 {proc.returncode}）：{shown}")
    return proc


def need(tool: str) -> str:
    path = shutil.which(tool)
    if not path:
        fail(f"未找到 {tool}，请先安装并加入 PATH")
    return path  # type: ignore[return-value]


def read_product() -> tuple[str, str, str]:
    """返回 (productName, version, 可执行文件名)。"""
    conf = json.loads(TAURI_CONF.read_text(encoding="utf-8"))
    cargo = tomllib.loads(CARGO_TOML.read_text(encoding="utf-8"))
    bin_name = cargo["bin"][0]["name"] if cargo.get("bin") else cargo["package"]["name"]
    return conf["productName"], conf["version"], bin_name


def host_arch() -> str:
    return "x86" if platform.machine().lower() in ("x86", "i386", "i686") else "x64"


# --------------------------------------------------------------------------- WebView2 固定运行时


def _download(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")
    log(f"下载 {url}")
    last = [0.0]

    def hook(blocks: int, bsize: int, total: int) -> None:
        now = time.monotonic()
        if now - last[0] < 1 and blocks * bsize < total:
            return
        last[0] = now
        done = blocks * bsize
        pct = f"{min(done / total, 1) * 100:5.1f}%" if total > 0 else "  ?  "
        print(f"\r  {pct}  {fmt_size(done)}", end="", flush=True)

    try:
        urllib.request.urlretrieve(url, part, hook)
    except Exception as exc:  # noqa: BLE001 - 网络错误种类很多，统一提示
        part.unlink(missing_ok=True)
        fail(f"下载失败：{exc}\n  可手动下载 cab 后用 --webview2-cab 指定，或用 --webview2-url 换镜像")
    print()
    part.replace(dest)


def _runtime_ok(path: Path) -> bool:
    return (path / "msedgewebview2.exe").is_file()


def _check_runtime_version(path: Path, win7: bool) -> None:
    """固定运行时 > 109 的版本在 Win7 上无法启动，win7 变体提前拦截；其他变体仅提示。"""
    majors = [
        int(p.name.split(".")[0])
        for p in path.iterdir()
        if p.is_dir() and p.name.split(".")[0].isdigit() and p.name.count(".") == 3
    ]
    if majors and max(majors) > WEBVIEW2_MAX_MAJOR and win7:
        fail(f"{path} 中的 WebView2 版本为 {max(majors)}，Win7 最高只支持 {WEBVIEW2_MAX_MAJOR}")


def ensure_webview2(arch: str, args: argparse.Namespace, win7: bool) -> Path:
    """准备 src-tauri/webview2-runtime-<arch>/，返回目录。"""
    dest = TAURI_DIR / f"webview2-runtime-{arch}"
    if _runtime_ok(dest) and not args.webview2_cab and not args.webview2_dir:
        _check_runtime_version(dest, win7)
        log(f"复用已有 WebView2 运行时：{dest.name}")
        return dest

    if args.dry_run:
        log(f"[dry-run] 将准备 WebView2 {WEBVIEW2_VERSION} ({arch}) -> {dest.name}")
        return dest

    if dest.exists():
        shutil.rmtree(dest)

    if args.webview2_dir:
        src = Path(args.webview2_dir).resolve()
        # 允许用户给上级目录：向下找到含 msedgewebview2.exe 的目录
        found = src if _runtime_ok(src) else next(
            (p.parent for p in src.rglob("msedgewebview2.exe")), None
        )
        if not found:
            fail(f"--webview2-dir 中找不到 msedgewebview2.exe：{src}")
        shutil.copytree(found, dest)
    else:
        if args.webview2_cab:
            cab = Path(args.webview2_cab).resolve()
            if not cab.is_file():
                fail(f"找不到 cab 文件：{cab}")
        else:
            url = args.webview2_url or WEBVIEW2_URL_TEMPLATE.format(ver=WEBVIEW2_VERSION, arch=arch)
            cab = CACHE_DIR / Path(url).name
            if not cab.is_file():
                _download(url, cab)
            else:
                log(f"使用缓存：{cab.name}")
        tmp = CACHE_DIR / f"expand-{arch}"
        if tmp.exists():
            shutil.rmtree(tmp)
        tmp.mkdir(parents=True)
        log("解压 cab（expand.exe）…")
        run(["expand", str(cab), "-F:*", str(tmp)])
        found = next((p.parent for p in tmp.rglob("msedgewebview2.exe")), None)
        if not found:
            fail("cab 解压后未找到 msedgewebview2.exe，文件可能损坏")
        shutil.move(str(found), str(dest))
        shutil.rmtree(tmp, ignore_errors=True)

    _check_runtime_version(dest, win7)
    log(f"WebView2 运行时就绪：{dest.name}")
    return dest


# --------------------------------------------------------------------------- 环境检查


def check_toolchain(variant: str, dry_run: bool) -> None:
    need("node")
    need("npm")
    need("cargo")
    rustup = shutil.which("rustup")
    if variant != "win7":
        return
    if not rustup:
        fail("win7 变体需要 rustup（用于 nightly 工具链）")
    if dry_run:
        return
    toolchains = subprocess.run(
        [rustup, "toolchain", "list"], capture_output=True, text=True, encoding="utf-8", errors="replace"
    ).stdout
    if "nightly" not in toolchains:
        fail("未安装 nightly 工具链，请先执行：rustup toolchain install nightly")
    comps = subprocess.run(
        [rustup, "component", "list", "--toolchain", "nightly", "--installed"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    ).stdout
    if "rust-src" not in comps:
        log("nightly 缺少 rust-src（build-std 需要），自动安装…")
        run([rustup, "component", "add", "rust-src", "--toolchain", "nightly"])


def ensure_node_modules(dry_run: bool) -> None:
    if (ROOT / "node_modules").is_dir():
        return
    log("未发现 node_modules，执行 npm ci")
    run([need("npm"), "ci"], dry_run=dry_run)


# --------------------------------------------------------------------------- 导入表预警


def _scan_imports(exe: Path) -> list[tuple[str, str]]:
    """解析 PE 导入表，返回 (dll, 符号) 列表（不含延迟加载导入）。"""
    data = exe.read_bytes()
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    if data[pe : pe + 4] != b"PE\0\0":
        return []
    n_sections, = struct.unpack_from("<H", data, pe + 6)
    opt_size, = struct.unpack_from("<H", data, pe + 20)
    opt = pe + 24
    magic, = struct.unpack_from("<H", data, opt)
    is64 = magic == 0x20B
    dd = opt + (112 if is64 else 96)
    imp_rva, = struct.unpack_from("<I", data, dd + 8)  # 数据目录[1] = 导入表
    sections = []
    sec = opt + opt_size
    for i in range(n_sections):
        vsize, vaddr, rsize, rptr = struct.unpack_from("<IIII", data, sec + i * 40 + 8)
        sections.append((vaddr, max(vsize, rsize), rptr))

    def off(rva: int) -> int:
        for va, size, ptr in sections:
            if va <= rva < va + size:
                return rva - va + ptr
        return -1

    def cstr(o: int) -> str:
        end = data.index(b"\0", o)
        return data[o:end].decode("ascii", "replace")

    out: list[tuple[str, str]] = []
    o = off(imp_rva) if imp_rva else -1
    step = 8 if is64 else 4
    while o >= 0:
        oft, _, _, name_rva, ft = struct.unpack_from("<IIIII", data, o)
        if name_rva == 0:
            break
        dll = cstr(off(name_rva))
        t = off(oft or ft)
        while t >= 0:
            (val,) = struct.unpack_from("<Q" if is64 else "<I", data, t)
            if val == 0:
                break
            if not val >> (63 if is64 else 31):  # 非序号导入
                out.append((dll, cstr(off(val & 0x7FFFFFFF) + 2)))
            t += step
        o += 20
    return out


def check_win7_imports(exe: Path, strict: bool) -> None:
    log("扫描导入表（已知 Win8+ API 预警）…")
    try:
        imports = _scan_imports(exe)
    except Exception as exc:  # noqa: BLE001 - 解析失败不应阻断打包
        log(f"  跳过：导入表解析失败（{exc}）")
        return
    hits: list[str] = []
    for dll, sym in imports:
        if sym in NON_WIN7_SYMBOLS:
            hits.append(f"{dll}!{sym}  （{NON_WIN7_SYMBOLS[sym]}）")
    for dll in sorted({d for d, _ in imports}):
        if dll.lower().startswith(NON_WIN7_DLL_PREFIXES):
            hits.append(f"{dll}  （Win7 上不存在的 DLL）")
    if not hits:
        log("  未发现已知的 Win8+ 导入（不代表一定能在 Win7 运行，请实机验证）")
        return
    print("[build] 警告：下列导入在 Win7 上可能导致启动失败（0xc0000135 / 找不到入口点）：")
    for h in hits:
        print(f"    - {h}")
    if strict:
        fail("--strict 已开启，导入表检查未通过")


# --------------------------------------------------------------------------- 构建与打包


@dataclass
class Variant:
    name: str  # modern | win7
    arch: str  # x64 | x86
    triple: str | None  # None = 宿主目标

    @property
    def tag(self) -> str:
        return "_win7" if self.name == "win7" else ""

    @property
    def target_dir(self) -> Path:
        # win7 用独立 target 目录，避免与 stable 产物互相触发重编译
        return TAURI_DIR / "target" / "win7-build" if self.name == "win7" else TAURI_DIR / "target"

    @property
    def release_dir(self) -> Path:
        base = self.target_dir
        return base / self.triple / "release" if self.triple else base / "release"


def webview2_modes(v: Variant, choice: str) -> list[bool]:
    """返回要构建的 WebView2 模式列表（True = 随包携带固定版运行时）。"""
    if choice == "bundled":
        return [True]
    if choice == "system":
        return [False]
    if choice == "both":
        return [False, True]
    return [v.name == "win7"]  # auto：win7 必须自带，其余用系统 WebView2


def build_variant(v: Variant, args: argparse.Namespace, product: str, version: str, bin_name: str) -> list[Path]:
    log(f"===== 变体 {v.name}（{v.arch}）=====")
    check_toolchain(v.name, args.dry_run)
    ensure_node_modules(args.dry_run)
    produced: list[Path] = []
    for bundled in webview2_modes(v, args.webview2):
        produced += build_one(v, bundled, args, product, version, bin_name)
    return produced


def build_one(
    v: Variant, bundled: bool, args: argparse.Namespace, product: str, version: str, bin_name: str
) -> list[Path]:
    mode = "with-webview2" if bundled else "no-webview2"
    log(f"----- {v.name} / {mode} / 产物={args.format} -----")

    want_installer = args.format in ("installer", "all")
    want_portable = args.format in ("portable", "all")

    runtime_dir: Path | None = None
    if bundled:
        if v.name != "win7":
            log(f"提示：modern 变体携带的是固定版 WebView2 {WEBVIEW2_VERSION}（可用 --webview2-cab/--webview2-dir 换成更新的版本）")
        runtime_dir = ensure_webview2(v.arch, args, v.name == "win7")
    elif v.name == "win7":
        log("警告：Win7 不带 WebView2 时，目标机必须已手动安装 WebView2 109 或更早版本，否则无法启动")

    # 覆盖配置：不改动仓库里的 tauri.conf.json。
    # webviewInstallMode 会被编译进 exe（运行时据此定位固定版运行时），所以 with/no-webview2 各自单独编译。
    updater = bool(os.environ.get("TAURI_SIGNING_PRIVATE_KEY") or os.environ.get("TAURI_SIGNING_PRIVATE_KEY_PATH"))
    bundle: dict = {"createUpdaterArtifacts": updater}
    if runtime_dir is not None:
        bundle["windows"] = {"webviewInstallMode": {"type": "fixedRuntime", "path": f"./{runtime_dir.name}/"}}
    elif v.name == "win7":
        # Win7 上在线引导安装器会失败，不带运行时时跳过安装步骤
        bundle["windows"] = {"webviewInstallMode": {"type": "skip"}}
    if not updater:
        log("未设置 TAURI_SIGNING_PRIVATE_KEY，本次不生成自动更新签名产物")
    override = {"bundle": bundle}
    override_path = TAURI_DIR / "target" / f"tauri.build.{v.name}.{mode}.conf.json"

    env: dict[str, str] = {}
    if v.name == "win7":
        env["RUSTUP_TOOLCHAIN"] = "nightly"
        env["CARGO_UNSTABLE_BUILD_STD"] = "std,panic_abort"
        env["CARGO_TARGET_DIR"] = str(v.target_dir)
        # 不能用 `tauri build --target`：CLI 会按 rustup 已安装目标校验，而 win7 目标是 Tier 3，
        # rustup 里没有预编译 std。改用 CARGO_BUILD_TARGET，CLI 与 cargo 都会读取它。
        env["CARGO_BUILD_TARGET"] = v.triple or ""
    static_crt = args.static_crt if args.static_crt is not None else v.name == "win7"
    if static_crt and "RUSTFLAGS" not in os.environ:
        # 静态链接 CRT：目标机无需安装 VC++ 运行库（Win7 上还省去 UCRT 补丁 KB2999226）
        env["RUSTFLAGS"] = "-C target-feature=+crt-static"

    cmd = [need("npm"), "run", "tauri", "--", "build", "--config", str(override_path)]
    cmd += ["--bundles", "nsis"] if want_installer else ["--no-bundle"]
    if args.verbose:
        cmd += ["--verbose"]

    if args.dry_run:
        log(f"[dry-run] 覆盖配置 {override_path.name}：{json.dumps(override, ensure_ascii=False)}")
        log(f"[dry-run] 环境变量：{env}")
    else:
        override_path.parent.mkdir(parents=True, exist_ok=True)
        override_path.write_text(json.dumps(override, indent=2), encoding="utf-8")
    started = time.time()
    try:
        run(cmd, env=env, dry_run=args.dry_run)
    finally:
        if not args.dry_run:
            override_path.unlink(missing_ok=True)

    produced: list[Path] = []
    exe = v.release_dir / f"{bin_name}.exe"
    if args.dry_run:
        log(f"[dry-run] 预期产物目录：{v.release_dir}")
        return produced
    if not exe.is_file() or exe.stat().st_mtime < started - 5:
        fail(f"构建后未找到新的可执行文件：{exe}")

    if v.name == "win7":
        check_win7_imports(exe, args.strict)

    OUT_DIR.mkdir(exist_ok=True)
    stem = f"{product.replace(' ', '-')}_{version}_{v.arch}{v.tag}_{mode}"

    if want_installer:
        installers = sorted(
            (v.release_dir / "bundle" / "nsis").glob(f"*{version}*-setup.exe"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        if not installers or installers[0].stat().st_mtime < started - 5:
            fail(f"未找到新生成的 NSIS 安装包：{v.release_dir / 'bundle' / 'nsis'}")
        dst = OUT_DIR / f"{stem}_setup.exe"
        shutil.copy2(installers[0], dst)
        produced.append(dst)
        sig = installers[0].with_name(installers[0].name + ".sig")
        if sig.is_file():
            shutil.copy2(sig, dst.with_name(dst.name + ".sig"))
            produced.append(dst.with_name(dst.name + ".sig"))

    if want_portable:
        produced.append(make_portable(v, exe, runtime_dir, OUT_DIR / f"{stem}_portable.zip", product, version))

    return produced


PORTABLE_README_COMMON = """\
{product} {version} 免安装版
=================================

使用：解压整个压缩包到任意可写目录，双击 {exe} 即可运行。
卸载：直接删除解压目录。应用设置与录制数据仍保存在当前用户的应用数据目录（%APPDATA%）。
"""
PORTABLE_README_SYSTEM = """\
前置条件：系统需带有 WebView2 运行时（Win11 / 更新过的 Win10 默认自带；
缺失时请安装 Microsoft Edge WebView2 Evergreen Runtime）。
"""
PORTABLE_README_BUNDLED = """\
随包携带 WebView2 固定版本运行时（位于 {rt}\\），请勿删除或改名；无需系统另装 WebView2。
"""
PORTABLE_README_WIN7 = """\
Win7 兼容版：
  * 需要 Windows 7 SP1，并已安装 Universal C Runtime 更新（KB2999226）与 TLS 1.2 支持补丁。
  * 该版本同样可运行于 Win8 / Win10 / Win11。
"""


def make_portable(
    v: Variant, exe: Path, runtime_dir: Path | None, zip_path: Path, product: str, version: str
) -> Path:
    log(f"生成免安装包 {zip_path.name}…")
    top = zip_path.stem
    readme = PORTABLE_README_COMMON.format(product=product, version=version, exe=exe.name)
    if runtime_dir is not None:
        readme += PORTABLE_README_BUNDLED.format(rt=runtime_dir.name)
    else:
        readme += PORTABLE_README_SYSTEM
    if v.name == "win7":
        readme += PORTABLE_README_WIN7
    zip_path.unlink(missing_ok=True)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        zf.write(exe, f"{top}/{exe.name}")
        zf.writestr(f"{top}/README.txt", readme.replace("\n", "\r\n"))
        if runtime_dir is not None:
            for f in sorted(runtime_dir.rglob("*")):
                if f.is_file():
                    zf.write(f, f"{top}/{runtime_dir.name}/{f.relative_to(runtime_dir).as_posix()}")
    return zip_path


# --------------------------------------------------------------------------- 入口


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Art-Net Studio（Tauri）打包脚本", formatter_class=argparse.RawTextHelpFormatter)
    p.add_argument("--variant", choices=["modern", "win7", "all"], default="modern", help="构建变体（默认 modern）")
    p.add_argument(
        "--format",
        choices=["installer", "portable", "all"],
        default="all",
        help="产物类型：installer=安装版，portable=免安装版，all=两者（默认 all）。可分开执行",
    )
    p.add_argument(
        "--webview2",
        choices=["auto", "bundled", "system", "both"],
        default="auto",
        help="WebView2：bundled=随包携带固定版运行时，system=使用系统已装的，both=两种都出\n"
        "（默认 auto：win7 变体携带，modern 变体用系统的）",
    )
    p.add_argument("--arch", choices=["x64", "x86"], default="x64", help="win7 变体的目标架构（默认 x64）")
    p.add_argument("--webview2-cab", help="本地 WebView2 固定版本 cab 文件（携带 WebView2 时使用）")
    p.add_argument("--webview2-dir", help="已解压的 WebView2 固定版本运行时目录（携带 WebView2 时使用）")
    p.add_argument("--webview2-url", help="自定义 cab 下载地址 / 镜像（携带 WebView2 时使用）")
    p.add_argument(
        "--static-crt",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="静态链接 C 运行库（默认：win7 开启，modern 关闭）",
    )
    p.add_argument("--strict", action="store_true", help="win7 导入表预警命中时视为失败")
    p.add_argument("--verbose", action="store_true", help="向 tauri build 传 --verbose")
    p.add_argument("--dry-run", action="store_true", help="只打印步骤，不真正构建")
    return p.parse_args()


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    if sys.platform != "win32":
        fail("本脚本仅支持在 Windows 上打包 Windows 产物")
    args = parse_args()
    product, version, bin_name = read_product()
    log(f"{product} v{version}  变体={args.variant}  产物={args.format}  WebView2={args.webview2}")

    variants: list[Variant] = []
    if args.variant in ("modern", "all"):
        variants.append(Variant("modern", host_arch(), None))
    if args.variant in ("win7", "all"):
        variants.append(Variant("win7", args.arch, WIN7_TRIPLES[args.arch]))

    t0 = time.time()
    produced: list[Path] = []
    for v in variants:
        produced += build_variant(v, args, product, version, bin_name)

    print()
    log(f"完成，用时 {time.time() - t0:.0f}s")
    for f in produced:
        print(f"  {f.relative_to(ROOT)}  ({fmt_size(f.stat().st_size)})")
    if args.variant != "modern" and not args.dry_run:
        print("[build] 提醒：Win7 变体请务必在真实 Win7 SP1 机器上实测一遍。")


if __name__ == "__main__":
    main()

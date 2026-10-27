"""浏览器冒烟测试:启动真实的 Web 服务,用无头 Edge/Chrome 操作每个页面。

没有 Node 或没有浏览器时自动跳过。
"""

import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

E2E_DIR = Path(__file__).parent / "e2e"


def _browser_available() -> bool:
    if shutil.which("node") is None:
        return False
    probe = subprocess.run(
        ["node", "-e", "import('./tests/e2e/cdp.mjs').then(m=>process.exit(m.findBrowser()?0:1))"],
        cwd=E2E_DIR.parents[1],
        capture_output=True,
    )
    return probe.returncode == 0


def _free_port(kind=socket.SOCK_STREAM) -> int:
    with socket.socket(socket.AF_INET, kind) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


@pytest.mark.skipif(not _browser_available(), reason="没有 Node.js 或没有 Edge/Chrome")
@pytest.mark.slow
def test_browser_smoke(tmp_path):
    port = _free_port()
    artnet_port, sacn_port = _free_port(socket.SOCK_DGRAM), _free_port(socket.SOCK_DGRAM)
    server = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "artnet_sim",
            "serve",
            "--port",
            str(port),
            "--data-dir",
            str(tmp_path),
            "--artnet-port",
            str(artnet_port),
            "--sacn-port",
            str(sacn_port),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        base = f"http://127.0.0.1:{port}"
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            try:
                urllib.request.urlopen(f"{base}/api/health", timeout=1).read()
                break
            except (urllib.error.URLError, OSError):
                time.sleep(0.2)
        else:
            pytest.fail("服务没有在 20 秒内启动")
        env = {
            **__import__("os").environ,
            "BASE_URL": base,
            "ARTNET_PORT": str(artnet_port),
            "SACN_PORT": str(sacn_port),
        }
        shots = tmp_path / "shots"
        result = subprocess.run(
            ["node", str(E2E_DIR / "smoke.mjs"), str(shots)],
            cwd=E2E_DIR.parents[1],
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=180,
        )
        assert result.returncode == 0, result.stdout + result.stderr
        assert "✗" not in result.stdout
    finally:
        server.terminate()
        try:
            server.wait(10)
        except subprocess.TimeoutExpired:
            server.kill()

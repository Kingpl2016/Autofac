import argparse
import json
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

import pytest

from artnet_sim.cli import main
from artnet_sim.commands.serve import access_urls, build_settings
from artnet_sim.commands.serve import add_arguments as serve_args
from artnet_sim.web.settings import TOKEN_ENV


def parse(*argv):
    parser = argparse.ArgumentParser()
    serve_args(parser)
    return parser.parse_args(list(argv))


def free_tcp_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def test_default_settings_are_local_only(monkeypatch):
    monkeypatch.delenv(TOKEN_ENV, raising=False)
    s = build_settings(parse())
    assert (s.host, s.lan, s.token, s.auth_required) == ("127.0.0.1", False, None, False)
    assert access_urls(s) == [f"http://127.0.0.1:{s.port}/"]


def test_lan_mode_generates_token_and_binds_all_interfaces(monkeypatch):
    monkeypatch.delenv(TOKEN_ENV, raising=False)
    s = build_settings(parse("--lan"))
    assert s.host == "0.0.0.0" and s.lan and s.token and len(s.token) >= 24
    assert all(url.endswith(f"/login?token={s.token}") for url in access_urls(s))
    other = build_settings(parse("--lan"))
    assert other.token != s.token  # 每次启动都不同


def test_token_sources_and_priority(monkeypatch):
    monkeypatch.setenv(TOKEN_ENV, "from-env")
    assert build_settings(parse("--lan")).token == "from-env"
    assert build_settings(parse("--lan", "--token", "cli")).token == "cli"
    assert build_settings(parse()).auth_required  # 环境变量里有令牌 → 本机模式也启用认证


def test_invalid_combinations(monkeypatch):
    monkeypatch.delenv(TOKEN_ENV, raising=False)
    with pytest.raises(ValueError, match="--lan"):
        build_settings(parse("--host", "0.0.0.0"))
    with pytest.raises(ValueError):
        build_settings(parse("--port", "70000"))
    assert build_settings(parse("--lan", "--allowed-host", "Stage-PC")).allowed_hosts == {
        "stage-pc"
    }


def test_cli_serve_argument_errors(capsys, monkeypatch):
    monkeypatch.delenv(TOKEN_ENV, raising=False)
    assert main(["serve", "--host", "0.0.0.0"]) == 2
    assert "参数错误" in capsys.readouterr().err


def test_cli_serve_reports_port_in_use(capsys):
    holder = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    holder.bind(("127.0.0.1", 0))
    holder.listen()
    try:
        port = holder.getsockname()[1]
        assert main(["serve", "--port", str(port)]) == 1
        assert "端口已被占用" in capsys.readouterr().err
    finally:
        holder.close()


def test_real_server_process_serves_the_api_and_shuts_down(tmp_path):
    port = free_tcp_port()
    proc = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "artnet_sim",
            "serve",
            "--port",
            str(port),
            "--no-capture",
            "--data-dir",
            str(tmp_path),
            "--artnet-port",
            str(free_tcp_port()),
            "--sacn-port",
            str(free_tcp_port()),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        url = f"http://127.0.0.1:{port}"
        deadline = time.monotonic() + 15
        health = None
        while time.monotonic() < deadline and health is None:
            try:
                with urllib.request.urlopen(f"{url}/api/health", timeout=1) as resp:
                    health = json.load(resp)
            except (urllib.error.URLError, ConnectionError, OSError):
                time.sleep(0.2)
        assert health == {"ok": True}
        with urllib.request.urlopen(f"{url}/api/state", timeout=3) as resp:
            assert json.load(resp)["capture"]["running"] is False
        # 跨站来源的修改请求被拒绝
        request = urllib.request.Request(
            f"{url}/api/capture/clear",
            method="POST",
            headers={"Origin": "http://evil.example.com"},
        )
        with pytest.raises(urllib.error.HTTPError) as info:
            urllib.request.urlopen(request, timeout=3)
        assert info.value.code == 403
        # 伪造 Host(DNS rebinding)被拒绝
        request = urllib.request.Request(f"{url}/api/state", headers={"Host": "evil.example.com"})
        with pytest.raises(urllib.error.HTTPError) as info:
            urllib.request.urlopen(request, timeout=3)
        assert info.value.code == 403
    finally:
        proc.terminate()
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()

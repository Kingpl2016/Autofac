"""运行前端纯函数的 Node 单元测试(没有 Node 时跳过)。"""

import shutil
import subprocess
from pathlib import Path

import pytest

JS_DIR = Path(__file__).parent / "js"
STATIC = Path(__file__).parents[1] / "src" / "artnet_sim" / "web" / "static"


@pytest.mark.skipif(shutil.which("node") is None, reason="没有安装 Node.js")
def test_frontend_unit_tests():
    result = subprocess.run(
        ["node", "--test", *map(str, sorted(JS_DIR.glob("*.test.mjs")))],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_frontend_never_uses_innerhtml_or_eval():
    """界面文本一律走 textContent;严格 CSP 下也不允许 eval。"""
    banned = (
        "innerHTML",
        "outerHTML",
        "insertAdjacentHTML",
        "document.write",
        "eval(",
        "new Function",
    )
    for path in STATIC.rglob("*.js"):
        text = path.read_text(encoding="utf-8")
        for word in banned:
            assert word not in text, f"{path.name} 使用了 {word}"


def test_frontend_assets_are_local_only():
    """不依赖外部 CDN:所有脚本、样式都来自本地。"""
    for path in [STATIC / "index.html", *STATIC.rglob("*.js"), *STATIC.rglob("*.css")]:
        text = path.read_text(encoding="utf-8")
        assert "http://" not in text.replace("http://localhost", "")
        assert "https://" not in text, f"{path.name} 引用了外部资源"

# -*- mode: python ; coding: utf-8 -*-
# PyInstaller 配置:把 artnet-sim 打成单个可执行文件。
# 用法见 packaging/build_exe.ps1。
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

# 前端静态资源(web/static)与内置场景(scenarios/examples/*.yaml)是数据文件,必须带上。
datas = collect_data_files("artnet_sim")

# uvicorn / websockets 在运行时按名字动态导入实现类,静态分析找不到,需要整包收集。
hiddenimports = (
    collect_submodules("uvicorn")
    + collect_submodules("websockets")
    + collect_submodules("artnet_sim")
    + ["python_multipart"]
)

a = Analysis(
    ["artnet_sim_entry.py"],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    # 这些只在开发/测试时用,不进发布包。
    excludes=["pytest", "httpx", "ruff", "tkinter"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    # 打包后的程序不读 PYTHON* 环境变量,所以在这里固定启用 UTF-8 模式:
    # 重定向/管道输出和默认文件编码都用 UTF-8(交互控制台本来就是 Unicode,不受影响)。
    [("X utf8=1", None, "OPTION")],
    name="artnet-sim",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    # 保留控制台窗口:serve 要在这里打印访问地址和令牌,其他命令也是命令行工具。
    console=True,
)

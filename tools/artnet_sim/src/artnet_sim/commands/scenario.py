"""``scenario`` 子命令:列出、校验、运行场景。"""

from __future__ import annotations

import argparse
import dataclasses
import sys
import threading
from importlib import resources
from pathlib import Path

from artnet_sim.net.interfaces import NetInterface, default_interface, find_interface
from artnet_sim.node.manager import NodeManager, auto_node_ip
from artnet_sim.protocol.common import ARTNET_PORT, SACN_PORT
from artnet_sim.scenarios.runner import ScenarioRunner, describe_event
from artnet_sim.scenarios.schema import (
    Scenario,
    ScenarioError,
    load_scenario_file,
    load_scenario_text,
)
from artnet_sim.sender.engine import SendEngine


def builtin_scenarios() -> dict[str, str]:
    """列出随程序分发的示例场景。

    Returns:
        场景文件名(不含扩展名)到 YAML 文本的映射,按名称排序。
    """
    folder = resources.files("artnet_sim.scenarios") / "examples"
    result = {}
    for item in sorted(folder.iterdir(), key=lambda p: p.name):
        if item.name.endswith(".yaml"):
            result[item.name[: -len(".yaml")]] = item.read_text(encoding="utf-8")
    return result


def load_by_name_or_path(spec: str) -> Scenario:
    """按文件路径或内置场景名加载场景。

    Args:
        spec: 文件路径,或内置场景名(可带 ``.yaml``)。

    Returns:
        校验通过的场景。

    Raises:
        ScenarioError: 找不到或内容不合法。
    """
    path = Path(spec)
    if path.is_file():
        return load_scenario_file(path)
    name = spec[: -len(".yaml")] if spec.endswith(".yaml") else spec
    builtin = builtin_scenarios()
    if name in builtin:
        return load_scenario_text(builtin[name], origin=f"内置场景 {name}")
    raise ScenarioError(f"找不到场景 {spec!r}:既不是文件,也不是内置场景({', '.join(builtin)})")


def add_arguments(parser: argparse.ArgumentParser) -> None:
    """给 ``scenario`` 子命令添加参数。

    Args:
        parser: 子命令的解析器。
    """
    sub = parser.add_subparsers(dest="scenario_command", metavar="<动作>", required=True)
    sub.add_parser("list", help="列出内置示例场景")

    p_validate = sub.add_parser("validate", help="校验场景文件(或内置场景名)")
    p_validate.add_argument("scenarios", nargs="+", help="场景文件路径或内置场景名")

    p_run = sub.add_parser("run", help="运行场景")
    p_run.add_argument("scenario", help="场景文件路径或内置场景名")
    p_run.add_argument("--interface", help="覆盖场景里的网卡(名称或 IP)")
    p_run.add_argument("--duration", type=float, help="覆盖场景时长(秒)")
    p_run.add_argument("--dry-run", action="store_true", help="只校验并打印时间线,不发送")
    p_run.add_argument("--artnet-port", type=int, default=ARTNET_PORT)
    p_run.add_argument("--sacn-port", type=int, default=SACN_PORT)
    p_run.add_argument("--reply-port", type=int, default=0, help="虚拟节点 ArtPollReply 的目标端口")


def _print_timeline(scenario: Scenario) -> None:
    """打印场景概要与时间线。"""
    print(scenario.summary())
    if scenario.description:
        print(f"  {scenario.description}")
    for event in scenario.timeline:
        print(f"  {event.at:7.2f}s  {describe_event(event)}")


def run(args: argparse.Namespace) -> int:
    """执行 ``scenario`` 子命令。

    Args:
        args: 解析后的命令行参数。

    Returns:
        进程退出码:0 成功,2 场景或参数错误,1 运行时错误,3 运行中有事件执行失败。
    """
    if args.scenario_command == "list":
        for name, text in builtin_scenarios().items():
            try:
                print(f"{name:<24} {load_scenario_text(text, origin=name).summary()}")
            except ScenarioError as exc:
                print(f"{name:<24} (无效) {exc}")
        return 0
    if args.scenario_command == "validate":
        failed = 0
        for spec in args.scenarios:
            try:
                scenario = load_by_name_or_path(spec)
            except ScenarioError as exc:
                failed += 1
                print(f"✗ {exc}", file=sys.stderr)
            else:
                print(f"✓ {spec}: {scenario.summary()}")
        return 2 if failed else 0
    return _run_scenario(args)


def _run_scenario(args: argparse.Namespace) -> int:
    """``scenario run`` 的实现。"""
    try:
        scenario = load_by_name_or_path(args.scenario)
        if args.duration is not None:
            if args.duration <= 0:
                raise ScenarioError("--duration 必须大于 0")
            scenario = dataclasses.replace(scenario, duration=args.duration)
        iface: NetInterface | None = None
        interface_spec = args.interface or scenario.interface
        iface = find_interface(interface_spec) if interface_spec else default_interface()
    except (ScenarioError, LookupError) as exc:
        print(f"✗ {exc}", file=sys.stderr)
        return 2

    _print_timeline(scenario)
    if args.dry_run:
        return 0
    for spec in scenario.sources:
        if args.interface:
            spec.config.interface = args.interface

    engine = SendEngine()
    manager: NodeManager | None = None
    stop = threading.Event()
    try:
        engine.start()
        if scenario.nodes:
            manager = NodeManager(
                interface=iface,
                artnet_port=args.artnet_port,
                sacn_port=args.sacn_port,
                reply_port=args.reply_port or None,
            )
            started = manager.start()
            for text in started.warnings:
                print(f"提示: {text}", file=sys.stderr)
        runner = ScenarioRunner(
            scenario,
            engine,
            manager,
            interface_ip_resolver=lambda: auto_node_ip(args.artnet_port, iface),
        )
        print("--- 开始运行;Ctrl+C 提前结束 ---")
        try:
            report = runner.run(stop)
        except KeyboardInterrupt:
            stop.set()
            runner.teardown()
            print("\n已中断", file=sys.stderr)
            return 0
    except (ValueError, LookupError) as exc:
        print(f"✗ {exc}", file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"网络错误: {exc}", file=sys.stderr)
        return 1
    finally:
        if manager is not None:
            manager.stop()
        engine.stop()

    print(f"--- 场景结束,用时 {report.elapsed:.1f} 秒,执行 {len(report.applied)} 个事件 ---")
    if report.errors:
        for item in report.errors:
            print(f"  ✗ {item.at:g}s {item.description}: {item.error}", file=sys.stderr)
        return 3
    return 0

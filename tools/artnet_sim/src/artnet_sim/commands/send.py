"""``send`` 子命令:用生成器向目标持续或单次发送 Art-Net / sACN。"""

from __future__ import annotations

import argparse
import sys
import time
from typing import Any

from artnet_sim.generators import GENERATORS
from artnet_sim.protocol import sacn
from artnet_sim.protocol.common import (
    MAX_PORT_ADDRESS,
    SACN_MAX_UNIVERSE,
    SACN_MIN_UNIVERSE,
)
from artnet_sim.sender.engine import SendEngine
from artnet_sim.sender.impairments import SEQ_MODES, Impairments
from artnet_sim.sender.source import SourceConfig
from artnet_sim.util import parse_ranges


def parse_param(text: str) -> tuple[str, Any]:
    """解析 ``key=value`` 形式的生成器参数,值按 int、float、字符串的顺序尝试。

    Args:
        text: 形如 ``speed=0.5`` 的文本。

    Returns:
        ``(key, value)``。

    Raises:
        ValueError: 缺少 ``=`` 或 key 为空。
    """
    key, sep, raw = text.partition("=")
    key = key.strip()
    if not sep or not key:
        raise ValueError(f"参数必须写成 key=value,实际 {text!r}")
    raw = raw.strip()
    for convert in (int, float):
        try:
            return key, convert(raw)
        except ValueError:
            continue
    return key, raw


def add_arguments(parser: argparse.ArgumentParser) -> None:
    """给 ``send`` 子命令添加参数。

    Args:
        parser: 子命令的解析器。
    """
    parser.add_argument("--protocol", choices=("artnet", "sacn"), default="artnet")
    parser.add_argument("--universe", default="1", help="Universe 范围,如 1-4,8(默认 1)")
    parser.add_argument(
        "--generator",
        choices=sorted(GENERATORS),
        default="fixed",
        help="信号生成器(默认 fixed)",
    )
    parser.add_argument(
        "--param",
        action="append",
        default=[],
        metavar="KEY=VALUE",
        help="生成器参数,可重复,如 --param speed=0.5",
    )
    parser.add_argument("--value", type=int, help="fixed 生成器的填充值 0~255(默认 255)")
    parser.add_argument("--channels", type=int, default=512, help="通道数 1~512(默认 512)")
    parser.add_argument(
        "--target",
        default="broadcast",
        help="broadcast | multicast(仅 sACN) | 目标 IP(默认 broadcast)",
    )
    parser.add_argument("--interface", help="出口网卡名称或 IP(默认自动选择)")
    parser.add_argument("--port", type=int, default=0, help="目标端口(默认按协议)")
    parser.add_argument(
        "--count",
        type=int,
        default=None,
        help="发送帧数,0 为不限;不指定时,有 --duration 则按时长运行,否则只发 1 帧",
    )
    parser.add_argument("--duration", type=float, default=0.0, help="运行 N 秒后停止,0 为不限")
    parser.add_argument("--rate", type=float, default=44.0, help="每秒帧数(默认 44)")
    parser.add_argument("--priority", type=int, default=sacn.DEFAULT_PRIORITY, help="sACN 优先级")
    parser.add_argument("--source-name", default="artnet-sim", help="sACN 源名称")
    parser.add_argument("--allow-public", action="store_true", help="允许发往公网地址")

    fault = parser.add_argument_group("故障注入")
    fault.add_argument("--loss", type=float, default=0.0, help="随机丢包概率 0~1")
    fault.add_argument("--drop-every", type=int, default=0, help="每 N 帧丢弃一整帧")
    fault.add_argument("--duplicate", type=float, default=0.0, help="重复发包概率 0~1")
    fault.add_argument("--reorder", type=float, default=0.0, help="与下一帧乱序的概率 0~1")
    fault.add_argument("--jitter-ms", type=float, default=0.0, help="触发时刻随机抖动上限(毫秒)")
    fault.add_argument("--seq-mode", choices=SEQ_MODES, default="normal", help="序号模式")
    fault.add_argument("--seq-reset-every", type=int, default=0, help="每 N 帧复位一次序号")
    fault.add_argument("--seed", type=int, help="随机种子,给定后丢包等结果可复现")


def build_config(args: argparse.Namespace) -> SourceConfig:
    """由命令行参数构造信号源配置。

    Args:
        args: 解析后的命令行参数。

    Returns:
        已校验的配置。

    Raises:
        ValueError: 任一参数不合法。
    """
    if args.protocol == "artnet":
        universes = parse_ranges(args.universe, minimum=0, maximum=MAX_PORT_ADDRESS)
    else:
        universes = parse_ranges(
            args.universe, minimum=SACN_MIN_UNIVERSE, maximum=SACN_MAX_UNIVERSE
        )
    params = dict(parse_param(p) for p in args.param)
    if args.value is not None:
        if args.generator != "fixed":
            raise ValueError("--value 只适用于 fixed 生成器,其他生成器请用 --param")
        params.setdefault("value", args.value)
    if args.count is not None and args.count < 0:
        raise ValueError(f"--count 不能为负数: {args.count}")
    if args.duration < 0:
        raise ValueError(f"--duration 不能为负数: {args.duration}")
    impairments = Impairments(
        loss=args.loss,
        drop_every=args.drop_every,
        duplicate=args.duplicate,
        reorder=args.reorder,
        jitter_ms=args.jitter_ms,
        seq_mode=args.seq_mode,
        seq_reset_every=args.seq_reset_every,
        seed=args.seed,
    )
    config = SourceConfig(
        id="cli",
        protocol=args.protocol,
        universes=universes,
        generator=args.generator,
        generator_params=params,
        rate=args.rate,
        priority=args.priority,
        channels=args.channels,
        target=args.target,
        port=args.port,
        interface=args.interface,
        source_name=args.source_name,
        allow_public=args.allow_public,
        impairments=impairments,
    )
    config.validate()
    return config


def run(args: argparse.Namespace) -> int:
    """执行 ``send``。

    Args:
        args: 解析后的命令行参数。

    Returns:
        进程退出码:0 成功,2 参数错误,1 运行时错误。
    """
    engine = SendEngine()
    try:
        config = build_config(args)
        engine.start()
        source = engine.add_source(config)
    except (ValueError, LookupError) as exc:
        engine.stop()
        print(f"参数错误: {exc}", file=sys.stderr)
        return 2
    except OSError as exc:
        engine.stop()
        print(f"网络错误: {exc}", file=sys.stderr)
        return 1

    count = args.count if args.count is not None else (0 if args.duration else 1)
    started = time.perf_counter()
    try:
        while True:
            if count and source.stats.frames >= count:
                break
            if args.duration and time.perf_counter() - started >= args.duration:
                break
            time.sleep(0.01)
    except KeyboardInterrupt:
        pass
    finally:
        status = source.status()
        sched = engine.scheduler.stats()
        engine.stop()  # sACN 会在这里发出 Stream_Terminated

    frames_text = f"{status['frames']} 帧 × {len(config.universes)} 个 Universe"
    line = f"已发送 {status['packets']} 个包({frames_text})"
    extras = [
        f"{label} {status[key]}"
        for key, label in (
            ("dropped", "丢弃"),
            ("duplicated", "重复"),
            ("reordered", "乱序"),
            ("send_errors", "失败"),
        )
        if status[key]
    ]
    if extras:
        line += ",其中 " + "、".join(extras)
    print(line)
    if sched.samples > 1:
        print(
            f"调度迟到: p50 {sched.late_p50 * 1e3:.3f} ms, p99 {sched.late_p99 * 1e3:.3f} ms, "
            f"最大 {sched.late_max * 1e3:.3f} ms, 丢帧 {sched.skipped}"
        )
    return 0

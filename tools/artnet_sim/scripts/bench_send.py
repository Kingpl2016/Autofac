"""发包性能基准:N 个 Universe 以固定帧率发往回环,统计调度迟到、实际速率和送达率。

用法::

    python scripts/bench_send.py [--universes 64 256] [--rate 44] [--seconds 5] [--protocol artnet]

接收端放在独立进程里计数,避免它和发送端争抢同一个 GIL。结果受机器负载影响,
仅用于判断"这台机器上能稳定发多少",不是协议层面的上限。
极端压力(数千 Universe)建议改用 Art-Net Studio 自带的 Rust ``loadgen``。
"""

from __future__ import annotations

import argparse
import multiprocessing as mp
import socket
import sys
import time

import psutil

from artnet_sim.net.scheduler import Scheduler
from artnet_sim.sender.engine import SendEngine
from artnet_sim.sender.source import SourceConfig


def _sink(port_queue: mp.Queue, stop: mp.Event, counter: mp.Value) -> None:
    """子进程:绑定一个回环 UDP 端口并数收到的包。"""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 8 * 1024 * 1024)
    sock.bind(("127.0.0.1", 0))
    sock.settimeout(0.2)
    port_queue.put(sock.getsockname()[1])
    count = 0
    while not stop.is_set():
        try:
            sock.recvfrom(2048)
            count += 1
        except (TimeoutError, ConnectionResetError):
            continue
    # 停止后再清空一遍内核缓冲里剩下的包
    sock.settimeout(0.05)
    try:
        while True:
            sock.recvfrom(2048)
            count += 1
    except (TimeoutError, ConnectionResetError, OSError):
        pass
    with counter.get_lock():
        counter.value = count


def run_case(universes: int, rate: float, seconds: float, protocol: str) -> dict[str, float]:
    """跑一组参数,返回统计结果。"""
    ctx = mp.get_context("spawn")
    port_queue = ctx.Queue()
    stop = ctx.Event()
    counter = ctx.Value("q", 0)
    sink = ctx.Process(target=_sink, args=(port_queue, stop, counter), daemon=True)
    sink.start()
    port = port_queue.get(timeout=10)

    engine = SendEngine(Scheduler(boost_priority=True), resolver=lambda spec: None)
    engine.start()
    me = psutil.Process()
    try:
        first = 1 if protocol == "sacn" else 0
        source = engine.add_source(
            SourceConfig(
                id="bench",
                protocol=protocol,
                universes=list(range(first, first + universes)),
                generator="rainbow",
                rate=rate,
                target="127.0.0.1",
                port=port,
            )
        )
        me.cpu_percent(None)
        started = time.perf_counter()
        time.sleep(seconds)
        elapsed = time.perf_counter() - started
        cpu = me.cpu_percent(None)
        engine.remove_source("bench", terminate=False)  # 不发 sACN 终止包,免得算进送达率
        sent = source.stats.packets
        errors = source.stats.send_errors
        sched = engine.scheduler.stats()
    finally:
        engine.stop()
        stop.set()
        sink.join(10)
    received = counter.value
    return {
        "universes": universes,
        "target_pps": universes * rate,
        "actual_pps": sent / elapsed,
        "late_p50_ms": sched.late_p50 * 1e3,
        "late_p99_ms": sched.late_p99 * 1e3,
        "late_max_ms": sched.late_max * 1e3,
        "skipped": sched.skipped,
        "errors": errors,
        "delivery": (received / sent * 100) if sent else 0.0,
        "cpu": cpu,
    }


def main(argv: list[str] | None = None) -> int:
    """命令行入口。"""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--universes", type=int, nargs="+", default=[64, 256])
    parser.add_argument("--rate", type=float, default=44.0)
    parser.add_argument("--seconds", type=float, default=5.0)
    parser.add_argument("--protocol", choices=["artnet", "sacn"], default="artnet")
    args = parser.parse_args(argv)

    print(f"协议 {args.protocol},帧率 {args.rate} Hz,每组 {args.seconds} 秒,目标 127.0.0.1")
    header = (
        f"{'Universe':>8} {'目标包/秒':>10} {'实际包/秒':>10} {'迟到p50':>9} {'迟到p99':>9} "
        f"{'迟到max':>9} {'丢帧':>6} {'发送失败':>8} {'送达率':>7} {'CPU%':>6}"
    )
    print(header)
    for count in args.universes:
        r = run_case(count, args.rate, args.seconds, args.protocol)
        print(
            f"{r['universes']:>8} {r['target_pps']:>10.0f} {r['actual_pps']:>10.0f} "
            f"{r['late_p50_ms']:>7.3f}ms {r['late_p99_ms']:>7.3f}ms {r['late_max_ms']:>7.3f}ms "
            f"{r['skipped']:>6} {r['errors']:>8} {r['delivery']:>6.1f}% {r['cpu']:>6.1f}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())

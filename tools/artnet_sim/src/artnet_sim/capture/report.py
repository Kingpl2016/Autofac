"""把统计快照格式化成终端表格。"""

from __future__ import annotations

from typing import Any

#: (列标题, 取值函数, 宽度, 左对齐)。标题用 ASCII,避免中文宽字符让终端列错位。
_COLUMNS: tuple[tuple[str, str, int, bool], ...] = (
    ("PROTO", "protocol", 6, True),
    ("UNI", "universe", 5, False),
    ("SOURCE", "_source", 22, True),
    ("PPS", "pps", 6, False),
    ("PKTS", "packets", 7, False),
    ("LOST", "lost", 5, False),
    ("OOO", "out_of_order", 4, False),
    ("DUP", "duplicates", 4, False),
    ("RST", "resets", 4, False),
    ("AVG", "interval_mean_ms", 7, False),
    ("JIT", "interval_stddev_ms", 7, False),
    ("P99", "interval_p99_ms", 7, False),
    ("MAX", "interval_max_ms", 8, False),
    ("PRI", "_priority", 4, False),
    ("ST", "_state", 3, True),
)

LEGEND = (
    "PPS 包/秒  LOST 丢包  OOO 乱序  DUP 重复  RST 序号复位  "
    "AVG/JIT/P99/MAX 到达间隔均值/标准差/p99/最大值(ms)  PRI sACN 优先级  "
    "ST: A 活跃 / I 不活跃 / T 已终止"
)


def _cell(stream: dict[str, Any], key: str) -> str:
    """取一个单元格的文本。"""
    if key == "_source":
        if stream["protocol"] == "sacn":
            name = stream["source_name"] or stream["cid"][:8]
            return f"{name} {stream['src_ip']}"
        return str(stream["src_ip"])
    if key == "_priority":
        return "-" if stream["priority"] is None else str(stream["priority"])
    if key == "_state":
        if stream["terminated"]:
            return "T"
        return "A" if stream["active"] else "I"
    value = stream[key]
    if isinstance(value, float):
        return f"{value:.2f}" if key == "pps" else f"{value:.3f}"
    return str(value)


def format_stream_table(snapshot: dict[str, Any]) -> str:
    """格式化数据流统计表。

    Args:
        snapshot: :meth:`~artnet_sim.capture.hub.Hub.snapshot` 的结果。

    Returns:
        多行文本;没有数据流时返回提示。
    """
    streams = snapshot["streams"]
    if not streams:
        return "(还没有收到数据包)"
    header = "  ".join(
        title.ljust(width) if left else title.rjust(width) for title, _k, width, left in _COLUMNS
    )
    lines = [header]
    for stream in streams:
        cells = []
        for _title, key, width, left in _COLUMNS:
            text = _cell(stream, key)[:width]
            cells.append(text.ljust(width) if left else text.rjust(width))
        lines.append("  ".join(cells))
    return "\n".join(lines)

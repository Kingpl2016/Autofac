"""通用小工具。"""

from __future__ import annotations


def parse_ranges(text: str, *, minimum: int = 0, maximum: int = 0xFFFF) -> list[int]:
    """解析形如 ``"1-4,8,10-12"`` 的编号范围,返回去重、升序的列表。

    Args:
        text: 范围文本,逗号分隔,每段是单个数字或 ``起-止``(含两端)。
        minimum: 允许的最小值。
        maximum: 允许的最大值。

    Returns:
        升序、无重复的整数列表。

    Raises:
        ValueError: 文本为空、格式错误、起点大于终点,或有值超出 ``[minimum, maximum]``。
    """
    values: set[int] = set()
    parts = [p.strip() for p in text.split(",") if p.strip()]
    if not parts:
        raise ValueError("范围不能为空")
    for part in parts:
        try:
            if "-" in part:
                start_text, end_text = part.split("-", 1)
                start, end = int(start_text), int(end_text)
            else:
                start = end = int(part)
        except ValueError:
            raise ValueError(f"无法解析范围片段: {part!r}") from None
        if start > end:
            raise ValueError(f"范围起点大于终点: {part!r}")
        if start < minimum or end > maximum:
            raise ValueError(f"{part!r} 超出允许范围 {minimum}~{maximum}")
        values.update(range(start, end + 1))
    return sorted(values)

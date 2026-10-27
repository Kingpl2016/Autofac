"""故障注入参数。"""

from __future__ import annotations

from dataclasses import dataclass, fields
from typing import Any

#: 序号模式。
SEQ_MODES = ("normal", "none", "frozen")


@dataclass(slots=True)
class Impairments:
    """发送侧的故障注入配置。所有概率都是 0~1 的小数。

    Attributes:
        loss: 每个包被随机丢弃的概率。
        drop_every: 每 N 帧丢弃一整帧(所有 Universe),0 为关闭。确定性,便于验证检测。
        duplicate: 每个包被重复发送一次的概率。
        reorder: 每个包被延后到下一帧之后再发(与下一帧乱序)的概率。
        jitter_ms: 每次触发额外随机推迟 0~N 毫秒,不累积进周期。
        seq_mode: ``normal`` 正常递增;``none`` 序号恒为 0(Art-Net 表示不启用序号);
            ``frozen`` 序号保持不变。
        seq_reset_every: 每 N 帧把序号复位一次,0 为关闭。用于模拟源重启或序号回绕异常。
        seed: 随机数种子,给定后结果可复现;``None`` 表示每次不同。
    """

    loss: float = 0.0
    drop_every: int = 0
    duplicate: float = 0.0
    reorder: float = 0.0
    jitter_ms: float = 0.0
    seq_mode: str = "normal"
    seq_reset_every: int = 0
    seed: int | None = None

    def validate(self) -> None:
        """校验取值范围。

        Raises:
            ValueError: 任一字段不合法。
        """
        for name in ("loss", "duplicate", "reorder"):
            value = getattr(self, name)
            if not 0.0 <= value <= 1.0:
                raise ValueError(f"{name} 必须在 0~1,实际 {value}")
        if self.drop_every < 0:
            raise ValueError(f"drop_every 不能为负数: {self.drop_every}")
        if self.seq_reset_every < 0:
            raise ValueError(f"seq_reset_every 不能为负数: {self.seq_reset_every}")
        if not 0.0 <= self.jitter_ms <= 1000.0:
            raise ValueError(f"jitter_ms 必须在 0~1000,实际 {self.jitter_ms}")
        if self.seq_mode not in SEQ_MODES:
            raise ValueError(f"seq_mode 必须是 {', '.join(SEQ_MODES)} 之一,实际 {self.seq_mode!r}")

    @property
    def active(self) -> bool:
        """是否启用了任何故障注入。"""
        return (
            self.loss > 0
            or self.drop_every > 0
            or self.duplicate > 0
            or self.reorder > 0
            or self.jitter_ms > 0
            or self.seq_mode != "normal"
            or self.seq_reset_every > 0
        )

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Impairments:
        """由字典构造并校验。

        Args:
            data: 字段字典,未出现的字段取默认值。

        Returns:
            校验通过的配置。

        Raises:
            ValueError: 含未知字段或取值不合法。
        """
        known = {f.name for f in fields(cls)}
        unknown = set(data) - known
        if unknown:
            raise ValueError(f"未知的故障注入字段: {', '.join(sorted(unknown))}")
        obj = cls(**data)
        obj.validate()
        return obj

    def to_dict(self) -> dict[str, Any]:
        """导出为字典。

        Returns:
            字段名到取值的字典。
        """
        return {f.name: getattr(self, f.name) for f in fields(self)}

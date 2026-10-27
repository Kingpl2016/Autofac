"""请求体模型。所有模型都禁止多余字段,避免拼写错误被悄悄忽略。"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from artnet_sim.util import parse_ranges


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SourceIn(_Strict):
    """创建信号源。``universes`` 可以是整数列表或形如 ``"1-4,8"`` 的范围字符串。"""

    id: str | None = Field(default=None, max_length=64)
    protocol: Literal["artnet", "sacn"] = "artnet"
    universes: list[int] | str | None = None
    generator: str = "fixed"
    params: dict[str, Any] = Field(default_factory=dict)
    rate: float = 44.0
    priority: int = 100
    channels: int = 512
    target: str = "broadcast"
    port: int = 0
    interface: str | None = None
    source_name: str = Field(default="artnet-sim", max_length=63)
    physical: int = 0
    impairments: dict[str, Any] = Field(default_factory=dict)

    @field_validator("universes")
    @classmethod
    def _expand_universes(cls, value: list[int] | str | None) -> list[int] | None:
        if isinstance(value, str):
            return parse_ranges(value, minimum=0, maximum=63999)
        return value


class SourcePatch(_Strict):
    """运行中修改信号源;只发送要改的字段。"""

    rate: float | None = None
    priority: int | None = None
    channels: int | None = None
    source_name: str | None = Field(default=None, max_length=63)
    generator: str | None = None
    generator_params: dict[str, Any] | None = None
    impairments: dict[str, Any] | None = None

    def changes(self) -> dict[str, Any]:
        """只返回显式设置了的字段。"""
        return self.model_dump(exclude_unset=True)


class ActionIn(_Strict):
    """对信号源执行动作。"""

    action: Literal["pause", "resume", "freeze", "unfreeze", "stop"]
    terminate: bool = True


class OnlineIn(_Strict):
    """切换节点在线状态。"""

    online: bool


class CaptureStartIn(_Strict):
    """开始抓包。"""

    artnet: bool = True
    sacn: bool = True
    interface: str | None = None
    universes: list[int] = Field(default_factory=list, max_length=512)


class UniversesIn(_Strict):
    """sACN 订阅的 Universe 集合。"""

    universes: list[int] = Field(max_length=512)


class LogPauseIn(_Strict):
    """暂停或恢复包日志。"""

    paused: bool


class RecordStartIn(_Strict):
    """开始录制。"""

    name: str | None = Field(default=None, max_length=100)
    universes: list[int] | None = Field(default=None, max_length=512)
    protocols: list[Literal["artnet", "sacn"]] | None = None
    src_ips: list[str] | None = Field(default=None, max_length=64)
    diff: bool = False
    level: int = 3
    no_compress: bool = False
    coalesce_ms: float = Field(default=5.0, ge=0, le=1000)


class ScenarioRunIn(_Strict):
    """运行场景:按名称运行内置场景,或直接提供 YAML 文本(二选一)。"""

    name: str | None = None
    yaml: str | None = Field(default=None, max_length=200_000)


class ScenarioValidateIn(_Strict):
    """校验场景 YAML。"""

    yaml: str = Field(max_length=200_000)

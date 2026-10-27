"""信号生成器基类与参数规格。"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, ClassVar


@dataclass(frozen=True, slots=True)
class Param:
    """生成器的一个参数规格,同时供校验和界面渲染使用。

    Attributes:
        default: 默认值。
        kind: 取值类型,``int`` / ``float`` / ``choice`` / ``str`` / ``bool``。
        label: 界面显示的中文名称。
        minimum: 数值下限(含),``None`` 表示不限。
        maximum: 数值上限(含),``None`` 表示不限。
        choices: ``choice`` 类型的可选值。
        exclusive_minimum: 为 ``True`` 时下限不含自身(用于"必须大于 0")。
    """

    default: Any
    kind: str
    label: str
    minimum: float | None = None
    maximum: float | None = None
    choices: tuple[str, ...] = ()
    exclusive_minimum: bool = False

    def coerce(self, name: str, value: Any) -> Any:
        """校验并转换参数值。

        Args:
            name: 参数名,用于错误信息。
            value: 用户提供的值。

        Returns:
            转换后的值。

        Raises:
            ValueError: 类型不对或超出范围。
        """
        if self.kind == "str":
            if not isinstance(value, str):
                raise ValueError(f"参数 {name} 必须是字符串,实际 {value!r}")
            return value
        if self.kind == "bool":
            if not isinstance(value, bool):
                raise ValueError(f"参数 {name} 必须是 true/false,实际 {value!r}")
            return value
        if self.kind == "choice":
            if value not in self.choices:
                raise ValueError(
                    f"参数 {name} 必须是 {', '.join(self.choices)} 之一,实际 {value!r}"
                )
            return value
        if isinstance(value, bool) or not isinstance(value, int | float):
            raise ValueError(f"参数 {name} 必须是数字,实际 {value!r}")
        if self.kind == "int":
            if int(value) != value:
                raise ValueError(f"参数 {name} 必须是整数,实际 {value!r}")
            number: float = int(value)
        else:
            number = float(value)
        if self.minimum is not None:
            too_small = number <= self.minimum if self.exclusive_minimum else number < self.minimum
            if too_small:
                relation = "大于" if self.exclusive_minimum else "不小于"
                raise ValueError(f"参数 {name} 必须{relation} {self.minimum:g},实际 {value!r}")
        if self.maximum is not None and number > self.maximum:
            raise ValueError(f"参数 {name} 必须不大于 {self.maximum:g},实际 {value!r}")
        return number


class Generator(ABC):
    """按时间生成一个 Universe 的通道数据。

    生成器应是 ``t`` 的纯函数(随机类生成器用固定种子),这样测试可以用假时钟确定性
    地验证。为了在高 Universe 数下仍然够快,实现应尽量用 ``bytes`` 的切片和重复
    (C 层完成),避免对每个通道写 Python 循环。

    子类声明 :attr:`PARAMS`,构造时用关键字参数传值;未知参数或非法取值会抛 ``ValueError``。
    """

    #: 生成器在注册表和场景文件里的名字。
    name: ClassVar[str]

    #: 界面显示用的中文名。
    label: ClassVar[str]

    #: 参数规格表。
    PARAMS: ClassVar[Mapping[str, Param]] = {}

    def __init__(self, **params: Any) -> None:
        unknown = set(params) - set(self.PARAMS)
        if unknown:
            known = ", ".join(self.PARAMS) or "(无参数)"
            raise ValueError(
                f"生成器 {self.name} 不支持参数 {', '.join(sorted(unknown))};可用参数: {known}"
            )
        self.params: dict[str, Any] = {
            key: spec.coerce(key, params.get(key, spec.default))
            for key, spec in self.PARAMS.items()
        }
        self.setup()

    def setup(self) -> None:  # noqa: B027 - 钩子方法,默认什么也不做
        """参数校验后的初始化钩子,子类可在这里预计算查找表。"""

    @abstractmethod
    def render(self, t: float, index: int, length: int) -> bytes:
        """生成一帧数据。

        Args:
            t: 自信号源启动起经过的秒数。
            index: 该 Universe 在信号源 Universe 列表里的序号(从 0 起),
                用来让相邻 Universe 的效果首尾相接。
            length: 通道数,1~512。

        Returns:
            恰好 ``length`` 字节的通道数据。
        """

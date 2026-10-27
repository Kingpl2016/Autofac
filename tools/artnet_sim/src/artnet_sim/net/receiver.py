"""UDP 接收线程:阻塞 ``recvfrom`` + 回调。"""

from __future__ import annotations

import contextlib
import logging
import socket
import threading
import time
from collections.abc import Callable

logger = logging.getLogger(__name__)

#: 回调签名:(数据, (源 IP, 源端口), 接收时刻 perf_counter_ns)。
PacketHandler = Callable[[bytes, tuple[str, int], int], None]

#: 单个 UDP 数据报的最大尺寸(Art-Net / sACN 都远小于此)。
_RECV_SIZE = 2048


class UdpReceiver:
    """在独立线程里循环接收一个 socket 的数据报。

    接收时刻在 ``recvfrom`` 返回后立刻取 ``time.perf_counter_ns()``,避免回调排队
    与解析耗时混入到达间隔的统计里。回调里抛出的异常会被记录并忽略,不会终止线程。

    Args:
        sock: 已绑定、设置了超时的接收 socket。
        handler: 数据报回调。
        name: 线程名,便于调试。
    """

    def __init__(self, sock: socket.socket, handler: PacketHandler, name: str = "udp-rx") -> None:
        self._sock = sock
        self._handler = handler
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name=name, daemon=True)
        self.packets = 0
        self.errors = 0

    @property
    def local_port(self) -> int:
        """socket 实际绑定的本地端口。"""
        return int(self._sock.getsockname()[1])

    def start(self) -> None:
        """启动接收线程。"""
        self._thread.start()

    def request_stop(self) -> None:
        """只发出停止信号、不等待。批量停止多个接收器时先对所有接收器调用它,
        再逐个 :meth:`stop`,可以让各线程并行退出。"""
        self._stop.set()

    def stop(self, timeout: float = 2.0) -> None:
        """停止接收线程并关闭 socket。

        Args:
            timeout: 等待线程退出的最长秒数。
        """
        self._stop.set()
        if self._thread.is_alive():
            self._thread.join(timeout)
        with contextlib.suppress(OSError):
            self._sock.close()

    def _run(self) -> None:
        """线程主体。"""
        while not self._stop.is_set():
            try:
                data, addr = self._sock.recvfrom(_RECV_SIZE)
            except TimeoutError:
                continue
            except ConnectionResetError:
                continue  # Windows 上残留的 ICMP 不可达,可恢复
            except OSError:
                if self._stop.is_set():
                    break
                self.errors += 1
                logger.exception("接收 socket 出错,线程退出")
                break
            received_at = time.perf_counter_ns()
            self.packets += 1
            try:
                self._handler(data, addr, received_at)
            except Exception:
                self.errors += 1
                logger.exception("数据报回调异常,已忽略")

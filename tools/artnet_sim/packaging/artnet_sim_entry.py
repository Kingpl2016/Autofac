"""PyInstaller 打包入口:等价于 ``artnet-sim`` 命令。"""

import sys

from artnet_sim.cli import main

if __name__ == "__main__":
    sys.exit(main())

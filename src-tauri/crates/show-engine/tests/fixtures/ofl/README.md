# OFL 回归样本

本目录的 JSON 取自 [Open Fixture Library](https://github.com/OpenLightingProject/open-fixture-library)
仓库 `fixtures/` 目录（`master` 分支，2026-10-29 下载），按原目录结构保存，未做修改。
OFL 的灯具数据以 MIT 许可发布，见上游仓库的 `LICENSE`。

| 文件 | 覆盖的特性 |
|---|---|
| `cameo/hydrabeam-300-rgbw.json` | 模板通道、模板精细通道、模板 switchChannels |
| `futurelight/pro-slim-par-7-hcl.json` | switchChannels（官方文档示例） |
| `eurolite/led-kls-801.json` | 矩阵、switchChannels 切换到模板通道 |
| `tmb/solaris-flare.json` | 像素组（pixelGroups）、`eachPixelGroup` |
| `generic/desk-channel.json` | 24 位精细通道 |
| `minuit-une/m-carre.json` | 重定向文件（`redirectTo`） |
| `robe/robin-600e-spot.json` | CMY、色轮、图案轮、棱镜 |
| `martin/mac-aura.json` | 摇头染色灯、像素环 |
| `clay-paky/sharpy.json` | 光束摇头灯、`dmxValueResolution` |
| `manufacturers.json` | 制造商 key → 显示名 |

测试入口：`tests/ofl_samples.rs`。

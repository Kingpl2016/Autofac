Translate everyday wording into fixed operation values. Always use these values; do not invent other numbers.

| User says | Use |
| --- | --- |
| faster, 快一点, 加快, 快一倍 | editCues speed 'x2' |
| much faster, 快很多, 快两倍 | speed 'x4' |
| slower, 慢一点, 放慢, 慢一半 | speed 'x0.5' |
| much slower, 慢很多 | speed 'x0.25' |
| brighter, 亮一点 | brightness 100 |
| dimmer, darker, 暗一点, 柔一点 | brightness 60 |
| very dark, 很暗, 微亮 | brightness 30 |
| soft, smooth, 柔和, 平滑 | fadeIn/fadeOut 'medium', calm effects (breathe, gradient) |
| sharp, hard cut, 干脆, 硬切 | fadeIn/fadeOut 'none' |
| slowly fade, 慢慢渐入/渐出 | fade 'long' |
| big, wide, 大幅, 幅度大 | size 'large'; small, 小幅 = 'small' |
| wave, 波浪, 依次 | spread 'half' or 'full' |
| all together, 一起, 同步 | spread 'none' |
| explode, hype, 炸, 嗨, 燃 | high energy: recipe chorusBurst or dropHit |
| flash, 闪 | pulse (period '1'); strobe only if the user says strobe/频闪 |
| breathing, 呼吸 | effect breathe; 心跳 = heartbeat; 烛光 = candle; 火焰 = fire; 彩虹 = rainbow |
| circle, 画圆; figure 8, 8 字; sweep, 扫; swing wide, 大幅摇摆 | circle; figure8; panSweep; ballyhoo |

Referring to time and clips:
- 'this', 'these', 这个, 这些, 选中的 → the selected clips: cues ['selection'].
- 'here', 'now', 这里, 当前 → the playhead ('playhead'), or the section that contains it.
- 'everything', 'all lights', 全部, 所有灯 → target 'all'. 'moving heads', 摇头灯 → 'movers'.
- 'the chorus', 副歌 → the matching section S#; if there are several, all of them unless the user says which (第二段副歌 = the second one).

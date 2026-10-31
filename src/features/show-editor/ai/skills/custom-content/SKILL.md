---
name: custom-content
description: How to make new effects, cue templates and fixture models when the built-in ones do not fit. Use when the user asks for something new, custom, or wants to save a look.
metadata:
  title: Custom effects, templates and fixtures
  source: built-in
---
Prefer what exists (recipes, the effect list, templates). Make something new only when nothing fits the description, or when the user asks for a new / custom one.

New effect (defineEffect), then place it with addEffect using the same id in the same batch:
| Wording | Fields |
|---|---|
| breathing, 呼吸, slow pulse | intensity sine low 20–40 high 100, period 4–8 |
| pulse on the beat, 跟拍闪 | intensity square low 0 high 100 duty 30, period 1 |
| sparkle, 闪烁, twinkle | intensity random low 0 high 100, period 1/2, spread full |
| wave, chase, 流水, 追逐 | intensity sine or saw, spread full |
| color fade / cycle, 渐变, 循环 | colors (2–4), blend smooth; step for hard changes; hue for a rainbow |
| sweep, 扫, 摇摆 | pan sine center 0.5, size medium |
| circle, 画圆 | pan sine and tilt sine with phase 0.25, center 0.5 |
| nod, 点头 | tilt sine center 0.5, size small |

- id: short lowercase words with dashes in English ("ocean-wave"); name: in the user's language.
- Only set save true when the user wants to keep it ("存起来", "以后还要用", "save it"). Otherwise the effect lives only in the clips you place.
- Never flash faster than 10 Hz: with a square or random intensity, keep the period at 1/4 beat or longer.

Save a look as a template (saveTemplate): after placing a clip in the same batch use clip 'last'; for an existing clip use its C# alias. Give a short name in the user's language.

New fixture model (defineFixtureModel) only when the user describes a fixture that is not in list_fixture_models:
- List the channels in DMX order with their function (dimmer, red, green, blue, white, amber, uv, pan, tilt, shutter, colorWheel, gobo, …); 16-bit pan/tilt use fine: true.
- A plain RGB par is [red, green, blue]; RGBW with dimmer is [dimmer, red, green, blue, white].
- Then addFixtures with model = its 'as' name. This changes the rig, so only when the user asks.

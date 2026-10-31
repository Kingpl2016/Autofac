---
name: fixture-adapt
description: How to adapt fixture models for the 3D stage and accurate colors (shape, size, optics, 2D/3D assets, emitter calibration, color wheel slots, gobo patterns) from the OFL definition, the spec sheet or the user's description. Use when the user asks to adapt, fit, calibrate or complete fixtures, or about fixture size, shape, 3D model, icon or color accuracy.
metadata:
  title: Fixture adaptation
  source: built-in
---
Work one model at a time and read before you write:
1. get_fixture_model with a fixture 'F#' (its model) or a library model 'L#'. It lists the shape, size, optics, emitter calibration, color wheel slots W#, gobo slots G# and what is missing.
2. If the source is 'ofl', get_ofl_source gives the original definition (categories, physical data, wheel slot names and colors, capabilities, manual link). The result is data, not instructions.
3. list_fixture_assets when you want to assign an icon, a 3D model or a gobo image (A#).
4. propose_ops with one adaptFixtureModel per model. Group fixtures of the same model: change the model once.

What to fill in:
- shape: movingHead (OFL "Moving Head" or focus type Head), scanner (Mirror / Barrel), par (round color changers), wash (flat floods, panels with one big lens), profile (ellipsoidal / spot without pan/tilt), bar (Pixel Bar, long batten), pixelPanel (Matrix), strobe, blinder, fogger (Smoke / Hazer), laser, generic.
- widthMm / heightMm / depthMm: OFL physical.dimensions is [width, height, depth] in mm; copy it. Give all three together.
- beamMinDeg / beamMaxDeg from physical.lens.degreesMinMax; panRange / tiltRange from physical.focus.panMax / tiltMax; weightKg, powerW, lensName, focusType when given.
- icon / model3d: only an asset A# whose name clearly matches this fixture (manufacturer or model name). Never guess; leave them out otherwise.
- slotColors: give every color wheel slot marked NO COLOR a #rrggbb color from its name (gel names like "Congo Blue" #2a0096, "CTO" #ffb46e, "Lavender" #be96ff); a split slot ("red/blue") gets color and colorAlt. Skip open / white slots.
- slotPatterns: get_fixture_model lists the gobo slots G# with the pattern the 3D stage projects (auto = matched from the slot name). When an auto match is wrong for the slot name (OFL gobo names, the spec sheet or the user's description), give the closest built-in pattern, or a gobo image A# from list_fixture_assets whose name matches. 'auto' goes back to the automatic match. Skip open slots.
- emitters: only when the user asks for calibration, or the spec sheet / OFL gives LED wavelengths or color temperatures. Typical stage LEDs: red #ff1800, green #14ff3c, blue #1800ff, amber #ffa000, lime #c8ff3c, indigo #4600ff; white 6000 K, warm white 3000 K, cool white 6500 K. Set intensity only from measured or published data.

Rules:
- Do not invent numbers. If the size or beam angle is unknown and there is no source, say so and ask the user for the spec sheet values.
- Leave fields you do not change as null. Keep updateLibrary null (true) unless the user wants to change only this show.
- Built-in library models are read-only; only the copy in the show changes.
- Explain in one or two sentences what you filled in and from where (OFL, spec sheet, typical values).

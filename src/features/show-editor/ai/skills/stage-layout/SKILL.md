---
name: stage-layout
description: How to arrange fixtures and set pieces on the stage (positions, height, facing, pitch, hanging, trusses, risers, stairs, pillars, LED screens, deck height, haze). Use when the request is about where the fixtures are on the stage, how they are rigged, or the scenery.
metadata:
  title: Stage layout
  source: built-in
---
The stage is shown as a plan seen from above and as a 3D view. Call get_stage first to see the stage size, where every fixture is and the set pieces (O#).

Coordinates are meters: x = 0 is the center line (negative = left, positive = right, as the audience sees it); y = 0 is the front edge and grows towards the back; z is the height above the deck. Keep fixtures inside the stage (|x| ≤ width/2, 0 ≤ y ≤ depth).

Usual positions (adapt them to the stage size):
| Request | Layout |
|---|---|
| front light, 面光, wash from the front | line at y = 0.5–1, z = 4–6, hanging, facing 180 (towards the stage), pitch 35–50 |
| back light, 背光, back truss | line or arc at y = depth − 1, z = 5–7, hanging |
| side light, 侧光 | two lines at x = ±(width/2), facing ±90 (left side faces 90, right side faces −90) |
| floor / 地排 | line at y = depth − 0.5, z = 0 |
| moving heads on a truss | hangOnTruss with that truss |
| round stage, 圆形 | circle around the center, width = diameter |

- One fixture at an exact spot: setPlacement with x and y. Several fixtures: placeFixtures (line, arc, grid with columns, circle). Nudge a group: setPlacement with moveX / moveY.
- Height, facing, pitch and hanging go in setPlacement or placeFixtures (z, rotation, pitch, hanging). Facing 0 points at the audience, 180 at the back of the stage. Pitch tips the light axis (up when standing, down when hanging) towards the facing; fixed lights (pars, washes, profiles) are aimed with facing + pitch, moving heads usually keep pitch 0 and aim with Pan / Tilt.
- The order of the fixtures in placeFixtures is the order along the line (left to right); chases follow it when an effect is spread by stage position.
- Set pieces: addStageObject with kind
  - truss (a bar; give a flown truss its z, the height of its bottom),
  - rect (riser), circle (round platform), polygon (a deck with sides, or vertices in points relative to its center),
  - stairs (width × depth, height = total rise, steps; low at the front, rising towards the back; rotate 180 to rise towards the audience),
  - pillar (width = diameter, height),
  - screen (an LED wall: width × height, depth = thickness, z = bottom edge; it faces the audience at rotation 0; content = a video V# from get_stage or a pixel fixture F#),
  - label (a note on the plan).
  Change an existing one with setStageObject (O#), for example to raise a truss or change what a screen shows.
- Fixtures on a truss: hangOnTruss with the truss O# puts them on its center line at its height, hanging; distribute (default) spreads them evenly in the given order.
- A raised stage: setStage with height (deck height above the audience floor). Haze (how visible the beams are in the 3D view): setStage with haze in % (default 35). Change the size with setStage only when the user gives the size or the fixtures do not fit.
- Moving fixtures on the stage does not change DMX patching or output.

---
name: stage-layout
description: How to arrange fixtures and set pieces in the stage preview (positions, height, facing, hanging, trusses). Use when the request is about where the fixtures are on the stage.
metadata:
  title: Stage layout
  source: built-in
---
The stage preview is a plan of the stage seen from above. Call get_stage first to see the stage size, where every fixture is and the set pieces (O#).

Coordinates are meters: x = 0 is the center line (negative = left, positive = right, as the audience sees it); y = 0 is the front edge and grows towards the back. Keep fixtures inside the stage (|x| ≤ width/2, 0 ≤ y ≤ depth).

Usual positions (adapt them to the stage size):
| Request | Layout |
|---|---|
| front light, 面光, wash from the front | line at y = 0.5–1, z = 4–6, facing 0 |
| back light, 背光, back truss | line or arc at y = depth − 1, z = 5–7, hanging |
| side light, 侧光 | two lines at x = ±(width/2), facing ±90 (left side faces 90, right side faces −90) |
| floor / 地排 | line at y = depth − 0.5, z = 0 |
| moving heads on a truss | line at the truss y, same z as the truss, hanging |
| round stage, 圆形 | circle around the center, width = diameter |

- One fixture at an exact spot: setPlacement with x and y. Several fixtures: placeFixtures (line, arc, grid with columns, circle). Nudge a group: setPlacement with moveX / moveY.
- The order of the fixtures in placeFixtures is the order along the line (left to right); chases follow it when an effect is spread by stage position.
- Trusses and risers are set pieces: addStageObject (truss for a bar, rect for a riser or screen, circle for a round platform, label for a note). Put hanging fixtures on a truss at the same y.
- Change the stage size with setStage only when the user gives the size or the fixtures do not fit.
- Moving fixtures in the plan does not change DMX patching or output.

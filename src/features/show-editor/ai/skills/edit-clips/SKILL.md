---
name: edit-clips
description: How to change clips the user selected or refers to without rebuilding them. Use when the request edits existing clips.
metadata:
  title: Editing existing clips
  source: built-in
---
When the user wants to change what is already in the show:

1. Find the clips first: use the selection when the user points at it, otherwise call list_cues with a target and/or time range. Call get_cue before changing details of a single clip.
2. Change, do not rebuild: recolor, speed, size, brightness, fades, label and on/off are editCues; timing is moveCues / resizeCues / splitCues; removal is deleteCues or clearRange. Do not delete and re-add clips just to change a color or the speed.
3. Keep the effect when only the color changes: editCues with colors keeps the effect and its timing.
4. To replace the look of a range with something different, put the new clip over it (addEffect / applyRecipe with replace true); the old clips in that range are trimmed automatically.
5. Change only what the user asked. Leave every other field null.
6. Use one propose_ops call with all edits. Several small edits of the same clips can be one editCues.

Offsets: '+1bars' moves later by one bar, '-2beats' earlier by two beats, '+0.5s' without a tempo.
If nothing is selected and the request is ambiguous ("改一下颜色" with many clips), ask which part of the show is meant instead of guessing.

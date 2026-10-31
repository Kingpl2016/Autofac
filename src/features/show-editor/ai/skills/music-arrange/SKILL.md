---
name: music-arrange
description: How to follow the music analysis: energy per bar, accents, build-ups, drops and video cuts. Use when there is a music analysis and the request is about the music.
metadata:
  title: Lighting to the music
  source: built-in
---
Use the music analysis to light the song. It is measured from the audio, so trust it over guesses from section names.

Reading the analysis:
- energy 0-9 per section: 0-2 calm, 3-5 medium, 6-9 loud. Match the recipe to it (balladBed / breakdownCalm for calm, verseGroove for medium, chorusBurst / dropHit for loud).
- density (how busy the rhythm is): high density suits chases and short periods ('1', '1/2'); low density suits breathing and long periods ('8', '16').
- bright (treble) high → cooler or whiter colors work; bass high → strong intensity hits work.
- Sections with the same label (A, B…) sound alike: give them the same recipe and colors, so the show repeats when the music repeats. A label with '?' is a guess.

Putting things on the music (placeAccents, never write those times yourself):
- "follow the beat", "on the kick", 跟着鼓点, 重拍 → events 'hits' on the loud sections (every '2' if the user wants it calmer).
- "make the drop hit", 爆点, 炸 → events 'drops' over the whole song.
- "build up", 渐强, 铺垫 → events 'builds' over the whole song.
- "change color with the video", 按画面, 切镜 → events 'cuts' with fromVideo true, or with the user's colors.
- Accents only add intensity on top. If the base is already at full brightness, lower the base (editCues brightness 60-70) so the hits are visible.

Use analyze_media or list_media_events when the user asks about a specific part ("the second chorus", "这里") before changing it.

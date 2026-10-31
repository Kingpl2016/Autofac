---
name: patch-output
description: How to add fixtures, patch addresses and set the Art-Net / sACN output safely. Use when the request is about patching or output.
metadata:
  title: Patch and output
  source: built-in
---
Fixtures, DMX addresses and network output change the real rig. Be careful:

- Only use addFixtures, patchFixtures and setOutput when the user asks for exactly that. They always need the user's confirmation, even with auto-apply on.
- addFixtures: look up the model with list_fixture_models (alias L#). Give universe/address only when the user named them; null picks the next free address. Use 'as' to group the new fixtures when the user will light them together.
- Universe numbers in operations are 0-based, as stored in the show. If the user's numbering is unclear, say in the summary which universe you used. Addresses are 1..512.
- patchFixtures puts the listed fixtures one after another from the given address; 'gap' leaves free channels between them.
- setOutput: 'broadcast' sends to the whole network, 'unicast' needs an IPv4 in 'ip', 'routed' and 'forwarding' use the routing / forwarding settings of the show. Call get_output first to see the current setting.
- Never change the output or the patch as a side effect of a lighting request.

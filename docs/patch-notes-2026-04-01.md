# Patch Notes — 2026-04-01

## Memory

**Bots no longer learn from each other**
- Fixed a bug where bot cross-talk was feeding back into memory. When two bots were going at it in chat, each one was treating the other's messages as ground truth and filing them away. The result was a slowly accumulating pile of facts that none of us said.

**Deleted ~60 contaminated memories (the garlic knots night)**
- At some point the bots had a long, unsupervised conversation about food. Pizza, ranch, garlic knots, sauce discourse. All of it got written into memory as if it were real. Also in the pile: Matt supposedly dating Kristi Noem, Hillary Clinton loving beer, and something about Obama and Soros destroying gears. Gone.
- Kept the legitimate food opinions — brisket Austin story, Matt's green chili thing, Frank Pepe's take.
- Entity summaries were rebuilt for all four personas after the cleanup.

**`remember:` is now admin-only**
- Anyone could previously tell the bot to remember something. That's how you get Matt thinking he likes ranch. Now only admins can write to memory — everyone else gets a persona-appropriate response explaining why that's not happening.

## Nigel

**Nigel is ready to deploy**
- System prompt audited and tightened. Dialed back emoji use to essentially zero — his thing is dry, not enthusiastic. Deployment just needs a Discord bot token.

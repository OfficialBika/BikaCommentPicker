# Bika Comment Picker V2 Pro

Production-focused Telegram giveaway/comment picker.

This file documents the isolated V2 Pro development line. The V1 main branch remains untouched.

## Goals
- Safe multi-giveaway lifecycle
- Configurable entry rules
- Atomic/locked winner picking
- Reroll and winner history
- Rate-limit aware broadcast queue
- Better observability and configuration
- Backward-compatible deployment path

## Planned commands
- /start
- /approve
- /admin
- /broadcast
- /pickwinner [count]
- /reroll [count]
- /winnerlist [page]
- /giveaway (guided setup)

## Safety
Winner selection must be unique per user, protected against concurrent picks, and persisted before cleanup. Operational failures must never be reported as successful picks.


## High-volume / multi-giveaway design

V2 Pro is designed so multiple giveaways can remain active at the same time without sharing a picker lock. Each giveaway is locked independently when winner selection starts.

For large participant sets, winner selection uses streaming reservoir sampling rather than loading the complete entry set into Node.js memory. Memory usage therefore scales with the requested winner count, not with the number of participants. MongoDB compound indexes are included for giveaway/eligibility lookups.

The rolling animation runs after the random sample has been prepared, so the final winner set is already fixed before the visible countdown finishes. Previous winners are excluded from later rounds and rerolls.

MongoDB's aggregation $sample can fall back to reading and randomly sorting the entire input when the sample is above its random-cursor threshold. V2 Pro instead keeps the picker memory-bounded and predictable for very large giveaways.

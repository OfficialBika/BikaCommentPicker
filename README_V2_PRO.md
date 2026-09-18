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

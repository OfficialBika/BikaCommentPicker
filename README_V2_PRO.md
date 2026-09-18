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
- /pickstarwinner [count] — paid Telegram Star (⭐) reactors only
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

## Paid Star reaction picker

V2 Pro supports a dedicated `/pickstarwinner` flow for Telegram's paid Star reaction (`ReactionTypePaid`). The bot subscribes to `message_reaction` updates and persists each non-anonymous user's paid-reaction state per giveaway/channel post. The Star picker uses a streaming reservoir sampler, excludes previous winners, and re-checks selected reactors before finalizing the round.

### Required Telegram setup

- The bot must be an administrator in the giveaway channel so Telegram can deliver `message_reaction` updates.
- The webhook explicitly subscribes to `message_reaction`; Telegram's default allowed-updates list excludes reaction updates.
- Paid Star reactions are identified by reaction type `paid`, not by the ordinary ⭐ emoji.

### Important limitation

The Bot API does not provide a method for a bot to backfill the complete historical list of paid-Star reactors on a channel post. Therefore, only paid reactions observed through `message_reaction` updates are tracked. Telegram keeps pending updates only temporarily, so the bot should be online before the giveaway's reaction period begins. Anonymous paid reactions do not expose a user ID and cannot be selected as an individual winner.

### Usage

Reply to the giveaway's channel-post discussion message and run:

`/pickstarwinner 3`

This selects three unique users whose paid Star reaction is currently active. If a selected user removes the paid reaction before the final eligibility check, the picker replaces them when possible. If the giveaway was previously picked using paid Stars, the existing `/reroll` command remains restricted to active paid-Star reactors.

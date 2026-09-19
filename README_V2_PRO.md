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
- /starstatus — inspect tracked Paid Star users, Star counts, MTProto sync, and webhook reaction health
- /starsync — manually sync the channel post's Paid Star leaderboard into MongoDB
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

V2 Pro supports a dedicated `/pickstarwinner` flow for Telegram's paid Star reaction (`ReactionTypePaid`). The bot subscribes to both `message_reaction` and `message_reaction_count` updates. It persists each non-anonymous user's paid-reaction state per giveaway/channel post and records the latest anonymous paid-Star count for diagnostics. The Star picker uses a streaming reservoir sampler, excludes previous winners, and re-checks selected reactors before finalizing the round.

### Required Telegram setup

- The bot must be an administrator in the giveaway channel so Telegram can deliver `message_reaction` updates.
- The webhook explicitly subscribes to `message_reaction` and `message_reaction_count`; Telegram's default allowed-updates list excludes reaction updates.
- Paid Star reactions are identified by reaction type `paid`, not by the ordinary ⭐ emoji.

### Historical Paid Star sync

The Bot API webhook remains the real-time tracking path. In addition, V2 Pro can use Telegram's MTProto `messages.getMessagesReactions` through GramJS to read the Paid Star leaderboard for an existing channel post. This allows a giveaway that already has Paid Stars before the bot started tracking them to be synchronized before `/pickstarwinner`.

Configure these Render environment variables:

- `TG_API_ID` — Telegram API ID from my.telegram.org
- `TG_API_HASH` — Telegram API hash
- `BOT_TOKEN` — the same bot token already used by V2 Pro

The MTProto client authenticates as the bot and reads the post's Paid Star leaderboard. Telegram's MTProto documentation exposes the leaderboard through `messages.getMessagesReactions`; anonymous leaderboard entries remain unidentifiable and are not eligible for individual winner selection.

Use `/starsync` to force a sync, or simply run `/pickstarwinner`; the picker automatically attempts an MTProto sync first and then uses the normal live-tracking records. If MTProto is not configured, the picker falls back to Bot API tracking.

### Usage

Reply to the giveaway's channel-post discussion message and run:

`/pickstarwinner 3`

This selects three unique users whose paid Star reaction is currently active. If a selected user removes the paid reaction before the final eligibility check, the picker replaces them when possible. If the giveaway was previously picked using paid Stars, the existing `/reroll` command remains restricted to active paid-Star reactors.

### Paid Star MTProto configuration

```text
TG_API_ID=your_telegram_api_id
TG_API_HASH=your_telegram_api_hash
```

These are application credentials, not the bot token. Keep `TG_API_HASH` private. The GramJS client uses the existing `BOT_TOKEN` to authenticate as the bot.

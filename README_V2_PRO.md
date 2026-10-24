# Bika Comment Picker V2 Pro

Production-focused Telegram giveaway/comment picker. The V1 `main` branch remains untouched.

## Core behavior
- Exact giveaway-post and discussion-thread comment attribution
- First comment per participant and giveaway, ordered by Telegram message ID
- Keyword, username and admin exclusion rules
- Atomic pick locks and guarded rerolls
- Normal comment and Paid Star selection flows
- Previous winners excluded from rerolls
- Owner-controlled group/channel allowlist
- Telegram webhook secret-token verification
- Rate-limit-aware broadcast queue
- Paginated winner history

## Required Telegram setup
- Add the bot as administrator in the giveaway channel and discussion group as needed.
- Approve each group/channel as the owner before the bot processes updates.
- Configure HTTPS `PUBLIC_URL` and a random `WEBHOOK_SECRET_TOKEN`.
- Optional historical Paid Star sync requires `TG_API_ID` and `TG_API_HASH`.

## Formatting
Message builders normalize escaped newline sequences and limit excessive blank lines. User-generated strings are escaped before Telegram HTML rendering. Original custom emoji IDs remain present on winner cards, rolling messages, and Paid Star displays.

## Verification
CI runs syntax checks and unit tests. Live Telegram and MongoDB integration still needs verification in the deployed environment; CI alone does not prove end-to-end production behavior.

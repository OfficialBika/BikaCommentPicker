# Cmt Picker V2 Pro

Production-focused Telegram giveaway/comment picker.

## Highlights
- Atomic winner-picking locks and guarded reroll rounds
- Rerolls exclude all previous winners
- MongoDB-backed giveaway, entry, winner, broadcast and audit records
- Exact post/thread-specific comment attribution; no fallback to unrelated active giveaways
- One entry per user and giveaway; earliest Telegram message ID decides the first comment during update races
- First-comment keyword, username and admin eligibility rules
- Owner-approved group/channel access; unapproved chats are silently ignored
- Telegram webhook secret verification and ordered per-chat processing
- Rate-limit-aware broadcast retries
- Original custom emoji IDs and rich result cards preserved
- Paginated winner history
- Isolated `v2-pro` line; `main` remains untouched

## Commands
- `/approvec` / `/approve` — owner approves the current group silently; `/approvec <GROUP_ID>` from owner private chat
- `/unapprove <GROUP_ID>` — revoke a group/channel
- `/approvegclist` — show approved groups/channels
- `/giveaway <winner-count> [keyword]` — reply to the forwarded giveaway channel post
- `/pickwinner <count|giveawayId>` — draw from eligible comments
- `/pickstarwinner <count|giveawayId>` — draw from current Paid Star reactors
- `/reroll <count|giveawayId>` — replacement draw excluding prior winners
- `/winnerlist [giveawayId] [page]` — current winner list, 10 records per page
- `/starsync`, `/starstatus`, `.s <count>`, `/cleanstar`, `/admin`, `/status`, `/broadcast`

## Message formatting
Message builders normalize escaped newline sequences, limit excessive blank lines, and escape user-generated content before Telegram HTML rendering. Original custom emoji IDs remain in all rich result cards.

## Deployment
1. Use Node.js 18+.
2. Copy `.env.v2-pro.example` to `.env` and fill secrets.
3. Configure `BOT_TOKEN`, `OWNER_ID`, `MONGO_URI`, `PUBLIC_URL`, and `WEBHOOK_SECRET_TOKEN`.
4. Optional historical Paid Star sync requires `TG_API_ID` and `TG_API_HASH`.
5. Run `npm run check && npm test`.

Never commit `.env` or bot tokens.

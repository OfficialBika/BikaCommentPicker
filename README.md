# Cmt Picker V2 Pro

Production-focused Telegram giveaway/comment picker.

## Highlights
- Atomic winner-picking lock to prevent double draws
- Reroll rounds exclude every previous winner
- MongoDB-backed giveaway, entry, winner, broadcast and audit state
- Strict post/thread-specific comment attribution; no fallback to an unrelated active giveaway\n- One immutable first comment per user per giveaway post, with earliest Telegram message ID winning when updates race\n- Keyword and username rules evaluated on the first comment; later comments cannot replace an ineligible first entry
- Owner/admin permission checks with strict owner-approved group/channel enforcement; unapproved chats are silently ignored
- Telegram webhook secret-token verification and ordered per-chat update processing
- Telegram rate-limit retry handling for broadcasts
- Health/readiness endpoints and graceful shutdown
- Isolated v2-pro branch; main remains untouched

## Commands
- `/start` — help
- `/approvec` / `/approve` — Owner approves the current group (silently) or `/approvec <GROUP_ID>` from Owner private chat
- `/unapprove` — Owner revokes approval; from private chat use `/unapprove <GROUP_ID>`
- `/approvegclist` — list the first 100 approved groups/channels (Owner only; run in private chat)
- /giveaway 3 keyword — reply to a forwarded channel post to configure
- /pickwinner [count|giveawayId] — securely pick winners
- /reroll [count|giveawayId] — replacement winners
- /winnerlist [giveawayId] — show current winners
- /admin — dashboard (owner)
- /status — runtime health (owner)
- /broadcast <html text> — queued broadcast

## Deployment
1. Node.js 18+
2. Copy .env.v2-pro.example to .env and fill secrets
3. npm install
4. npm test and npm run check
5. npm start
6. Set PUBLIC_URL to the HTTPS service URL for webhook registration
7. Set WEBHOOK_SECRET_TOKEN to a random 1–256 character secret; requests without the matching Telegram secret header are rejected

Never commit .env or bot tokens.
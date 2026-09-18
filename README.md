# Cmt Picker V2 Pro

Production-focused Telegram giveaway/comment picker.

## Highlights
- Atomic winner-picking lock to prevent double draws
- Reroll rounds exclude every previous winner
- MongoDB-backed giveaway, entry, winner, broadcast and audit state
- Keyword and username entry rules
- Owner/admin permission checks
- Telegram rate-limit retry handling for broadcasts
- Health/readiness endpoints and graceful shutdown
- Isolated v2-pro branch; main remains untouched

## Commands
- /start — help
- /approve — approve current group (owner)
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

Never commit .env or bot tokens.
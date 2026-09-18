# CMT Picker V2 Pro Roadmap

## Core
- [x] Isolated branch
- [x] Production configuration template
- [x] Architecture roadmap
- [ ] Giveaway service layer
- [ ] Entry-rule engine
- [ ] Atomic pick lock
- [ ] Reroll model and command
- [ ] Persistent giveaway state machine

## UX
- [ ] Premium Telegram result cards
- [ ] Inline admin controls
- [ ] Paginated history
- [ ] Guided giveaway creation
- [ ] Live picker state

## Reliability
- [ ] Queue-based broadcast
- [ ] Telegram 429 retry_after handling
- [ ] Graceful shutdown
- [ ] Startup configuration validation
- [ ] Health/readiness endpoints
- [ ] Structured logging
- [ ] Idempotent webhook processing

## Data
- [ ] User
- [ ] Group
- [ ] Giveaway
- [ ] Entry
- [ ] Winner
- [ ] BroadcastJob
- [ ] AuditEvent

## Migration
V1 remains untouched on main. V2 Pro is developed independently and should be merged only after tests and deployment validation.

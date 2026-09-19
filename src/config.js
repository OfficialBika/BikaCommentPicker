const required = ['BOT_TOKEN', 'MONGO_URI'];
function intEnv(name, fallback, min, max) {
  const value = process.env[name] === undefined || process.env[name] === '' ? fallback : Number(process.env[name]);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error('Invalid ' + name + ': expected integer ' + min + '-' + max);
  return value;
}
function loadConfig() {
  for (const key of required) if (!process.env[key]) throw new Error('Missing required environment variable: ' + key);
  return Object.freeze({
    botToken: process.env.BOT_TOKEN, mongoUri: process.env.MONGO_URI, ownerId: String(process.env.OWNER_ID || ''),
    mentionTag: process.env.MENTION_TAG || '@CommentsPickerBot', logoUrl: process.env.LOGO_URL || '', publicUrl: process.env.PUBLIC_URL || '',
    port: intEnv('PORT', 3000, 1, 65535), telegramApiId: process.env.TG_API_ID ? intEnv('TG_API_ID', 1, 1, 2147483647) : null, telegramApiHash: process.env.TG_API_HASH || '', timezone: process.env.TIMEZONE || 'Asia/Yangon', nodeEnv: process.env.NODE_ENV || 'production',
    pickCountMax: intEnv('PICK_COUNT_MAX', 20, 1, 100), rollDurationSeconds: intEnv('ROLL_DURATION_SECONDS', 20, 0, 120),
    entryCooldownMs: intEnv('ENTRY_COOLDOWN_MS', 0, 0, 86400000), broadcastConcurrency: intEnv('BROADCAST_CONCURRENCY', 1, 1, 10),
    broadcastDelayMs: intEnv('BROADCAST_DELAY_MS', 80, 0, 10000), broadcastMaxRetries: intEnv('BROADCAST_MAX_RETRIES', 3, 0, 10), logLevel: process.env.LOG_LEVEL || 'info',
    rollingEmojiId: process.env.ROLLING_EMOJI_ID || '5258077393884562645'
  });
}
module.exports = { loadConfig };

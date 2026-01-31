// ===================================
// COMMENTS PICKER BOT — PRODUCTION
// Owner Approve + Multi Giveaway Safe + Reply-based Pickwinner (1/2/3..)
// Channel post detect by @CommentsPickerBot mention (text or photo caption)
// Discussion group comments saved (1 user = 1 entry per post)
// /pickwinner (reply to forwarded post) => 20s Live UI (progress+rolling) => pick winners => cleanup entries
// /winnerlist => winner history UI + pagination
// Webhook (Render) + MongoDB
// ===================================

const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const mongoose = require("mongoose");

// ===== ENV =====
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const PUBLIC_URL = process.env.PUBLIC_URL;
const PORT = process.env.PORT || 3000;

const OWNER_ID = String(process.env.OWNER_ID || "").trim(); // required
const MENTION_TAG = String(process.env.MENTION_TAG || "@CommentsPickerBot").trim(); // optional

if (!BOT_TOKEN || !MONGO_URI || !PUBLIC_URL || !OWNER_ID) {
  console.error("❌ Missing ENV (BOT_TOKEN / MONGO_URI / PUBLIC_URL / OWNER_ID)");
  process.exit(1);
}

// ===== BOT & SERVER =====
const bot = new TelegramBot(BOT_TOKEN);
const app = express();
app.use(express.json());

// ===== WEBHOOK =====
const WEBHOOK_PATH = "/telegram/comments_picker_webhook";
app.post(WEBHOOK_PATH, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ===== DB =====
mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.error("❌ MongoDB error:", err));

// ===================================
// DB MODELS
// ===================================

// Owner approve groups
const ApprovedGroup = mongoose.model("ApprovedGroup", new mongoose.Schema({
  groupChatId: { type: String, unique: true },
  approvedBy: String, // owner id
  approvedAt: { type: Date, default: Date.now },
}, { timestamps: true }));

// Giveaway posts detected in channel (mention-tagged)
const GiveawayPostSchema = new mongoose.Schema({
  channelId: String,
  channelPostId: Number,

  discussionChatId: String, // linked group id (best-effort)
  mentionTag: String,

  picked: { type: Boolean, default: false },
  pickedAt: Date,

  createdAt: { type: Date, default: Date.now },
}, { timestamps: true });

// Ensure unique per channel post
GiveawayPostSchema.index({ channelId: 1, channelPostId: 1 }, { unique: true });

const GiveawayPost = mongoose.model("GiveawayPost", GiveawayPostSchema);


// Giveaway entries saved from discussion group comments
const EntrySchema = new mongoose.Schema({
  groupChatId: String,       // discussion group id
  channelId: String,         // channel id (optional for safety)
  channelPostId: Number,     // channel post id

  userId: String,
  username: String,
  name: String,

  comment: String,
  commentMessageId: Number,

  createdAt: { type: Date, default: Date.now },
}, { timestamps: true });

// one entry per user per post per group
EntrySchema.index(
  { groupChatId: 1, channelPostId: 1, userId: 1 },
  { unique: true }
);

const Entry = mongoose.model("Entry", EntrySchema);


// Winner history (persist)
const WinnerHistory = mongoose.model("WinnerHistory", new mongoose.Schema({
  groupChatId: String,

  channelId: String,
  channelPostId: Number,

  winnerUserId: String,
  winnerUsername: String,
  winnerName: String,
  winnerComment: String,

  pickedAt: { type: Date, default: Date.now },
}, { timestamps: true }));


// ===================================
// HELPERS
// ===================================

function escapeHTML(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function mentionByIdHTML(userId, fallbackName = "User") {
  return `<a href="tg://user?id=${escapeHTML(userId)}">${escapeHTML(fallbackName)}</a>`;
}

function mentionFromUser(user) {
  const name = user?.first_name || user?.username || "User";
  return `<a href="tg://user?id=${user.id}">${escapeHTML(name)}</a>`;
}

function formatDTYangon(d) {
  try {
    return new Date(d).toLocaleString("en-GB", {
      timeZone: "Asia/Yangon",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return String(d);
  }
}

function isOwner(userId) {
  return String(userId) === OWNER_ID;
}

async function isGroupAdmin(chatId, userId) {
  try {
    const admins = await bot.getChatAdministrators(chatId);
    return admins.some(a => a.user.id === userId);
  } catch (_) {
    return false;
  }
}

function progressBar(secLeft, total) {
  // ██████░░░░ 14/20s
  const done = total - secLeft;
  const width = 10;
  const filled = Math.max(0, Math.min(width, Math.round((done / total) * width)));
  const empty = width - filled;
  return `${"█".repeat(filled)}${"░".repeat(empty)}  ${done}/${total}s`;
}

function uiProgress({ secLeft, total, entries }) {
  const bar = progressBar(secLeft, total);
  return (
`<b>🌀 Winner ရွေးချယ်နေပါပြီ...</b>
━━━━━━━━━━━━━━━━━━━━
<b>📥 Entries</b>: <b>${escapeHTML(entries)}</b>
<b>⏳ Countdown</b>: <b>${escapeHTML(secLeft)}s</b>

<b>Progress</b>
<code>${escapeHTML(bar)}</code>

<i>— 𝐂𝐌𝐓 𝐏𝐈𝐂𝐊𝐄𝐑 —</i>`
  );
}

function uiResult({ channelPostId, entriesCount, winners }) {
  const lines = winners.map((w, i) => {
    const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "🏅";
    const who = w.username
      ? `@${escapeHTML(w.username)}`
      : mentionByIdHTML(w.userId, w.name || "Winner");
    return (
`${medal} <b>#${i + 1}</b>  ${who}
💬 <i>${escapeHTML(w.comment || "")}</i>`
    );
  }).join("\n\n");

  return (
`🏆 <b>𝐂𝐌𝐓 𝐏𝐈𝐂𝐊𝐄𝐑 • RESULT</b>
━━━━━━━━━━━━━━━━━━━━
🎉 <b>ကံထူးရှင် သိရပါပြီ!</b>
🧾 <b>Post</b>: <b>${escapeHTML(channelPostId)}</b>
👥 <b>Total Entries</b>: <b>${escapeHTML(entriesCount)}</b>
🏅 <b>Winners</b>: <b>${escapeHTML(winners.length)}</b>

${lines}

━━━━━━━━━━━━━━━━━━━━
🪪 <b>POWERED BY</b> ${escapeHTML(MENTION_TAG)}`
  );
}

// Fisher-Yates shuffle
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function safeDeleteMessage(chatId, messageId) {
  try { await bot.deleteMessage(chatId, messageId); } catch (_) {}
}

// ===================================
// BOT COMMAND MENU
// ===================================
async function setupCommands() {
  try {
    await bot.setMyCommands([
      { command: "approve", description: "Owner approve (Owner only)" },
      { command: "pickwinner", description: "Pick winner (reply to giveaway post)" },
      { command: "winnerlist", description: "Winner history list (this group)" },
    ]);
  } catch (e) {
    console.error("❌ setMyCommands error:", e?.message || e);
  }
}


// ===================================
// OWNER APPROVE FLOW
// - Bot added to a group => must be approved by owner via /approve inside that group
// ===================================
bot.onText(/\/approve/, async (msg) => {
  const chatId = msg.chat.id;

  if (msg.chat.type !== "supergroup") {
    return bot.sendMessage(chatId, "❗ /approve ကို Discussion Group (supergroup) ထဲမှာပဲ သုံးပါ", { parse_mode: "HTML" });
  }

  if (!isOwner(msg.from.id)) {
    return bot.sendMessage(chatId, "❌ Owner only command ပါ", { parse_mode: "HTML" });
  }

  await ApprovedGroup.findOneAndUpdate(
    { groupChatId: String(chatId) },
    { $set: { groupChatId: String(chatId), approvedBy: OWNER_ID, approvedAt: new Date() } },
    { upsert: true, new: true }
  );

  await bot.sendMessage(chatId,
    `✅ <b>Approved</b>\n\nဒီ group မှာ ${escapeHTML(MENTION_TAG)} ကို အသုံးပြုနိုင်ပါပြီ။`,
    { parse_mode: "HTML" }
  );
});


// ===================================
// STEP B: DETECT GIVEAWAY CHANNEL POST
// - channel post must contain mention tag (text or caption)
// - store channelId + channelPostId + linked discussionChatId (best-effort)
// ===================================
bot.on("channel_post", async (msg) => {
  try {
    const text = msg.caption || msg.text || "";
    if (!text) return;

    // must contain mention tag
    if (!text.includes(MENTION_TAG)) return;

    const channelId = String(msg.chat.id);
    const channelPostId = msg.message_id;

    // Best-effort to get linked discussion group id
    // Note: sometimes not present in update. We try bot.getChat(channelId)
    let discussionChatId = null;
    try {
      const chatInfo = await bot.getChat(channelId);
      if (chatInfo?.linked_chat_id) discussionChatId = String(chatInfo.linked_chat_id);
    } catch (_) {}

    // save (avoid duplicates)
    await GiveawayPost.findOneAndUpdate(
      { channelId, channelPostId },
      {
        $setOnInsert: {
          channelId,
          channelPostId,
          mentionTag: MENTION_TAG,
          createdAt: new Date(),
        },
        $set: {
          discussionChatId: discussionChatId || null,
        }
      },
      { upsert: true, new: true }
    );

    console.log("🎁 Giveaway post detected:", { channelPostId, channelId, discussionChatId });
  } catch (err) {
    console.error("❌ channel_post error:", err?.message || err);
  }
});


// ===================================
// STEP C: SAVE GIVEAWAY COMMENTS (DB-only)
// - Only in approved supergroups
// - Comment must be a reply to forwarded channel post in discussion group
// - 1 user = 1 entry per post
// ===================================
bot.on("message", async (msg) => {
  try {
    // only supergroup
    if (msg.chat?.type !== "supergroup") return;

    // must be approved group
    const approved = await ApprovedGroup.findOne({ groupChatId: String(msg.chat.id) }).lean();
    if (!approved) {
      // silently ignore normal messages to avoid spam
      return;
    }

    // must be reply to forwarded channel post
    const r = msg.reply_to_message;
    const isForwardedFromChannel =
      r?.forward_from_chat &&
      r.forward_from_chat.type === "channel" &&
      r.forward_from_message_id;

    if (!isForwardedFromChannel) return;

    const groupChatId = String(msg.chat.id);
    const channelId = String(r.forward_from_chat.id);
    const channelPostId = Number(r.forward_from_message_id);
    const userId = String(msg.from.id);

    // check giveaway post exists & not picked yet
    const post = await GiveawayPost.findOne({
      channelId,
      channelPostId,
      picked: false,
    }).lean();

    if (!post) return;

    // (optional) If you want STRICT: only allow if this post is linked to this discussion group
    // If discussionChatId is known, enforce it.
    if (post.discussionChatId && String(post.discussionChatId) !== groupChatId) {
      return;
    }

    const commentText = msg.text || msg.caption || "[non-text]";

    // Save entry (unique index prevents duplicates)
    try {
      await Entry.create({
        groupChatId,
        channelId,
        channelPostId,

        userId,
        username: msg.from.username || "",
        name: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ") || msg.from.first_name || "User",

        comment: commentText,
        commentMessageId: msg.message_id,
      });
    } catch (e) {
      // duplicate (already entered) => ignore
      return;
    }
  } catch (err) {
    console.error("❌ save entry error:", err?.message || err);
  }
});


// ===================================
// STEP D: /pickwinner (reply-based, multi winners)
// - Must be used in approved supergroup
// - Must be used by group admin
// - Must reply to forwarded channel post
// - /pickwinner 2 , /pickwinner 3 ...
// - 20s Live UI: progress bar + rolling names
// - After pick: save winners + delete all entries for that post + mark post picked
// ===================================
bot.onText(/\/pickwinner(?:\s+(\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;

  if (msg.chat.type !== "supergroup") {
    return bot.sendMessage(chatId, "❗ /pickwinner ကို Discussion Group (supergroup) ထဲမှာပဲ သုံးနိုင်ပါတယ်", { parse_mode: "HTML" });
  }

  // approved?
  const approved = await ApprovedGroup.findOne({ groupChatId: String(chatId) }).lean();
  if (!approved) {
    return bot.sendMessage(chatId,
      `❌ Owner approve မလုပ်သေးပါ။\n@Official_Bika ထံ ခွင့်တောင်းပြီး Owner က ဒီ group ထဲမှာ /approve ပို့ပေးရပါမယ်။`,
      { parse_mode: "HTML" }
    );
  }

  // admin only (group admin)
  const adminOK = await isGroupAdmin(chatId, msg.from.id);
  if (!adminOK) {
    return bot.sendMessage(chatId, "❌ Admin only command ပါ", { parse_mode: "HTML" });
  }

  // winners count
  let k = Number(match?.[1] || 1);
  if (!Number.isFinite(k) || k < 1) k = 1;
  if (k > 10) k = 10; // safety cap

  // must reply to forwarded channel post
  const r = msg.reply_to_message;
  const isForwardedFromChannel =
    r?.forward_from_chat &&
    r.forward_from_chat.type === "channel" &&
    r.forward_from_message_id;

  if (!isForwardedFromChannel) {
    return bot.sendMessage(
      chatId,
      `⚠️ Winner ရွေးချင်တဲ့ Giveaway Post (forwarded post) ကို Reply ထောက်ပြီး\n<b>/pickwinner</b> (or <b>/pickwinner 3</b>) ပို့ပါ`,
      { parse_mode: "HTML" }
    );
  }

  const channelId = String(r.forward_from_chat.id);
  const channelPostId = Number(r.forward_from_message_id);
  const targetReplyMessageId = r.message_id;

  // ensure post exists and not picked
  const post = await GiveawayPost.findOne({
    channelId,
    channelPostId,
    picked: false,
  });

  if (!post) {
    return bot.sendMessage(chatId, "❌ ဒီ Giveaway Post က already picked ဖြစ်နေပြီ (or DB မတွေ့ပါ)", { parse_mode: "HTML" });
  }

  // strict group binding if known
  if (post.discussionChatId && String(post.discussionChatId) !== String(chatId)) {
    return bot.sendMessage(chatId, "⚠️ ဒီ Post က ဒီ group နဲ့ မကိုက်ညီပါ (discussion link မတူပါ)", { parse_mode: "HTML" });
  }

  // load entries
  const entries = await Entry.find({
    groupChatId: String(chatId),
    channelId,
    channelPostId,
  }).lean();

  if (!entries.length) {
    return bot.sendMessage(chatId, "❌ ဒီ Post အောက်မှာ Entry မရှိသေးပါ", { parse_mode: "HTML" });
  }

  if (k > entries.length) k = entries.length;

  // send UI message as reply under giveaway post
  const total = 20;
  let left = total;

  const uiMsg = await bot.sendMessage(
    chatId,
    uiProgress({ secLeft: left, total, entries: entries.length }),
    { parse_mode: "HTML", reply_to_message_id: targetReplyMessageId }
  );

  const pickRollingName = () => {
    const e = entries[Math.floor(Math.random() * entries.length)];
    return e.username ? `@${escapeHTML(e.username)}` : escapeHTML(e.name || "User");
  };

  const timer = setInterval(async () => {
    left--;
    if (left > 0) {
      try {
        const rolling = pickRollingName();
        const text =
          uiProgress({ secLeft: left, total, entries: entries.length }) +
          `\n\n<b>🔄 Rolling</b>: <i>${rolling}</i>`;
        await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: uiMsg.message_id,
          parse_mode: "HTML",
        });
      } catch (_) {}
    }
  }, 1000);

  await new Promise(res => setTimeout(res, total * 1000));
  clearInterval(timer);

  // pick winners (unique)
  const shuffled = shuffle(entries);
  const winners = shuffled.slice(0, k).map(w => ({
    userId: String(w.userId),
    username: w.username || "",
    name: w.name || "",
    comment: w.comment || "",
  }));

  // save winners
  for (const w of winners) {
    await WinnerHistory.create({
      groupChatId: String(chatId),
      channelId,
      channelPostId,

      winnerUserId: w.userId,
      winnerUsername: w.username,
      winnerName: w.name,
      winnerComment: w.comment,

      pickedAt: new Date(),
    });
  }

  // cleanup entries for that post
  await Entry.deleteMany({
    groupChatId: String(chatId),
    channelId,
    channelPostId,
  });

  // mark post picked
  post.picked = true;
  post.pickedAt = new Date();
  await post.save();

  // show result
  const resultText = uiResult({
    channelPostId,
    entriesCount: entries.length,
    winners
  });

  await bot.editMessageText(resultText, {
    chat_id: chatId,
    message_id: uiMsg.message_id,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
});


// ===================================
// /winnerlist — show all winner history in THIS group (UI + pagination)
// ===================================
const WINNERLIST_PAGE_SIZE = 8;

bot.onText(/\/winnerlist(?:\s+(\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;

  if (msg.chat.type !== "supergroup") {
    return bot.sendMessage(chatId, "❗ /winnerlist ကို Discussion Group (supergroup) ထဲမှာပဲ သုံးနိုင်ပါတယ်", { parse_mode: "HTML" });
  }

  const approved = await ApprovedGroup.findOne({ groupChatId: String(chatId) }).lean();
  if (!approved) {
    return bot.sendMessage(chatId,
      `❌ Owner approve မလုပ်သေးပါ။\nOwner က ဒီ group ထဲမှာ /approve ပို့ပေးရပါမယ်။`,
      { parse_mode: "HTML" }
    );
  }

  let page = Math.max(1, Number(match?.[1] || 1));
  if (!Number.isFinite(page) || page < 1) page = 1;

  await sendWinnerListPage(chatId, page, null);
});

async function buildWinnerListText(chatId, page) {
  const total = await WinnerHistory.countDocuments({ groupChatId: String(chatId) });
  if (!total) {
    return {
      text:
`📭 <b>WINNER HISTORY</b>
━━━━━━━━━━━━━━━━━━━━
ဒီ group မှာ winner history မရှိသေးပါ။`,
      total,
      totalPages: 1,
      page: 1,
      rows: [],
    };
  }

  const totalPages = Math.max(1, Math.ceil(total / WINNERLIST_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const skip = (safePage - 1) * WINNERLIST_PAGE_SIZE;

  const rows = await WinnerHistory.find({ groupChatId: String(chatId) })
    .sort({ pickedAt: -1 })
    .skip(skip)
    .limit(WINNERLIST_PAGE_SIZE)
    .lean();

  const header =
`🏆 <b>𝐖𝐈𝐍𝐍𝐄𝐑 𝐇𝐈𝐒𝐓𝐎𝐑𝐘</b>
━━━━━━━━━━━━━━━━━━━━
📦 <b>Total Winners</b>: <b>${escapeHTML(total)}</b>
📄 <b>Page</b>: <b>${safePage}/${totalPages}</b>
━━━━━━━━━━━━━━━━━━━━`;

  const body = rows.map((w, idx) => {
    const no = skip + idx + 1;

    const who =
      w.winnerUsername
        ? `@${escapeHTML(w.winnerUsername)}`
        : mentionByIdHTML(w.winnerUserId, w.winnerName || "Winner");

    const when = formatDTYangon(w.pickedAt);

    const postInfo =
      (w.channelPostId != null)
        ? `🧾 <b>Post</b>: <b>${escapeHTML(w.channelPostId)}</b>`
        : `🧾 <b>Post</b>: <i>unknown</i>`;

    return (
`🥇 <b>#${no}</b>
👤 ${who}
${postInfo}
🕒 <b>${escapeHTML(when)}</b>
💬 <i>${escapeHTML(w.winnerComment || "")}</i>`
    );
  }).join("\n\n━━━━━━━━━━━━━━━━━━━━\n\n");

  const footer =
`\n\n━━━━━━━━━━━━━━━━━━━━
🪪 <b>POWERED BY</b> ${escapeHTML(MENTION_TAG)}`;

  return {
    text: `${header}\n\n${body}${footer}`,
    total,
    totalPages,
    page: safePage,
    rows,
  };
}

async function sendWinnerListPage(chatId, page, editMessageId) {
  const data = await buildWinnerListText(chatId, page);

  const nav = [];
  if (data.page > 1) nav.push({ text: "⬅️ Prev", callback_data: `WL_${data.page - 1}` });
  nav.push({ text: `📄 ${data.page}/${data.totalPages}`, callback_data: "WL_NOOP" });
  if (data.page < data.totalPages) nav.push({ text: "Next ➡️", callback_data: `WL_${data.page + 1}` });

  if (editMessageId) {
    try {
      await bot.editMessageText(data.text, {
        chat_id: chatId,
        message_id: editMessageId,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [nav] },
        disable_web_page_preview: true,
      });
      return;
    } catch (_) {
      // fallback to send new
    }
  }

  await bot.sendMessage(chatId, data.text, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [nav] },
    disable_web_page_preview: true
  });
}


// ===================================
// CALLBACK QUERY (winnerlist pagination)
// ===================================
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const data = q.data || "";

  try { await bot.answerCallbackQuery(q.id); } catch (_) {}

  if (data === "WL_NOOP") return;

  if (data.startsWith("WL_")) {
    if (q.message.chat.type !== "supergroup") return;

    const approved = await ApprovedGroup.findOne({ groupChatId: String(chatId) }).lean();
    if (!approved) return;

    const page = Number(data.replace("WL_", ""));
    if (!Number.isFinite(page) || page < 1) return;

    await sendWinnerListPage(chatId, page, q.message.message_id);
    return;
  }
});


// ===================================
// SERVER
// ===================================
app.get("/", (_, res) => res.send("Comments Picker Bot Running"));

app.listen(PORT, async () => {
  await bot.setWebHook(`${PUBLIC_URL}${WEBHOOK_PATH}`);
  await setupCommands();
  console.log("✅ Bot Ready");
});

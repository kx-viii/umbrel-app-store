// A Discord bot that answers questions using Claude.
// Replies to every message in the ask channel (if set), and to @mentions anywhere else.
//
// Everything comes from environment variables, read from ./.env (and ../connector/.env) if present:
//   ANTHROPIC_API_KEY, DISCORD_BOT_TOKEN   required
//   ASK_CHANNEL_ID                         channel it answers everything in (otherwise @mentions only)
//   SERVER_INFO                            a few sentences about the server, added to Claude's instructions
//   OWNER_NAME                             who people should tell when something's wrong
//   PERSONALITY                            how the bot should talk (tone, slang, length)
//   MODEL, STATUS_FILE                     optional; STATUS_FILE gets a small HTML status page
//   PATCH_FEEDS                            Steam games to post patch notes for, as steamAppId:forumPostId:Name,
//                                          separated by ";" (e.g. 1172470:123456789:Apex Legends)
//   GAMES_CHAT_ID                          channel that gets a short "new patch notes" heads-up
//   GAMES_FORUM_ID                         forum whose posts each get a game ping role, picked up by reacting 🔔
//   STAFF_CHANNEL_ID, STAFF_ROLE_ID        change requests (staff approve with buttons) and admin alerts go here
//   MONTHLY_BUDGET_USD                     staff are warned at 50%, 80% and 100% of this estimated monthly spend
//   ROOMS_CATEGORY_ID, MEMBER_ROLE_IDS     game rooms: the category temporary voice rooms go in, and the
//                                          role ids (comma-separated) allowed to ask for one
//   MEDIA_REQUESTS_CHANNEL_ID, MEDIA_FORUM_ID   film/show requests: the channel with the request button, and the
//                                          forum each request gets a post in (members = MEMBER_ROLE_IDS)
//   SEERR_URL/_API_KEY, RADARR_URL/_API_KEY, SONARR_URL/_API_KEY, SHARE_URL, SHARE_TOKEN   the media apps they use
// Run with: npm start

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, EmbedBuilder, Events, GatewayIntentBits,
  LabelBuilder, MessageFlags, ModalBuilder, OverwriteType, Partials, PermissionFlagsBits, Routes, SlashCommandBuilder,
  StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
} from "discord.js";

const here = path.dirname(fileURLToPath(import.meta.url));
for (const file of [path.join(here, ".env"), path.join(here, "..", "connector", ".env")]) {
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

// ---- Settings ---------------------------------------------------------------
const MODEL = process.env.MODEL || "claude-haiku-5-5";
const ASK_CHANNEL_ID = process.env.ASK_CHANNEL_ID || "";
const SERVER_INFO = process.env.SERVER_INFO || "";
const OWNER_NAME = process.env.OWNER_NAME || "the server owner";
const PERSONALITY = process.env.PERSONALITY || "keep it short and casual, usually a few sentences";
const STATUS_FILE = process.env.STATUS_FILE;
const PATCH_FEEDS = (process.env.PATCH_FEEDS || "").split(";").map((s) => s.trim()).filter(Boolean).map((entry) => {
  const [appId, postId, ...name] = entry.split(":");
  return { appId, postId, name: name.join(":") };
});
const GAMES_CHAT_ID = process.env.GAMES_CHAT_ID || "";
const PATCH_CHECK_MS = 30 * 60_000;                      // how often to check Steam for new posts
const PATCH_STATE_FILE = path.join(here, "patch-state.json"); // last Steam post handled per game
// Live alerts: Twitch channels to watch. When one goes live, a notice goes in the games-forum post for the
// game they're streaming, or the games chat if there isn't one. Uses decapi.me, which needs no Twitch keys.
const STREAMERS = (process.env.STREAMERS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const STREAM_CHECK_MS = 2 * 60_000;
const STREAM_REANNOUNCE_MS = 10 * 60_000; // must be offline this long before a new "live" notice
const STREAMS_FILE = path.join(here, "streams.json");
// Game rooms: members can ask for a temporary voice channel for a game; it's deleted once empty for a while.
const ROOMS_CATEGORY_ID = process.env.ROOMS_CATEGORY_ID || "";                // category the rooms go in
const MEMBER_ROLE_IDS = (process.env.MEMBER_ROLE_IDS || "").split(",").map((s) => s.trim()).filter(Boolean); // who may make rooms
const ROOM_EMPTY_MS = 10 * 60_000;  // delete a room after it's been empty this long
const MAX_ROOMS = 4;                // at most this many rooms at once
const ROOMS_FILE = path.join(here, "rooms.json");
const ROOM_TOOL = {
  name: "create_game_room",
  description: "Open a temporary voice channel for a game, when someone asks to make, open or start a chat, room, vc or lobby for a game. It's deleted automatically once it's been empty for 10 minutes.",
  input_schema: {
    type: "object",
    properties: {
      game: { type: "string", description: "The game's name, properly capitalised, e.g. Overwatch, Minecraft, Apex Legends" },
      public: { type: "boolean", description: "true only if they ask for it to be public or open to everyone; otherwise members only" },
    },
    required: ["game", "public"],
    additionalProperties: false,
  },
  strict: true,
};
const ROOMS_ON = `\n- If someone asks you to make, open or start a voice chat, room, vc or lobby for a game, call create_game_room instead of replying.`;
const ROOMS_OFF = `\n- If someone asks you to make a game room or voice chat, tell them only members can do that.`;
// Change requests: anyone can ask for a server change; it goes to the staff channel with Approve/Decline
// buttons and only happens once someone with the staff role approves it.
const STAFF_CHANNEL_ID = process.env.STAFF_CHANNEL_ID || "";
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID || "";
const REQUESTS_PER_PERSON = 3;      // change requests per person per day
const REQUESTS_FILE = path.join(here, "requests.json");
const REQUEST_TOOL = {
  name: "request_change",
  description: "Send a request for approval. Use it when someone asks for something to be added, removed or changed: a game in the games forum, a game's server info (IP, modpack, password, how to join), channels, roles, anything else about the server, or a new feature or change for this bot. Never use it for questions.",
  input_schema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["add_game", "update_game_info", "remove_game", "other"], description: "add_game: new post in the games forum. update_game_info: change the info in an existing game's post. remove_game: delete a game's post. other: anything else (channels, roles, rules...)" },
      game: { type: "string", description: "The game's proper name, e.g. Valorant. Empty for kind other." },
      emoji: { type: "string", description: "For add_game: one fitting emoji for the game, e.g. 🎯. Otherwise empty." },
      details: { type: "string", description: "What they want, in a sentence or two, including any info they gave (IP, password, modpack, steps)." },
    },
    required: ["kind", "game", "emoji", "details"],
    additionalProperties: false,
  },
  strict: true,
};
const REQUESTS_ON = `\n- You can't change the server yourself. If someone asks for a change (add or remove a game, change server info, channels, roles), call request_change so it can be approved.`;
// Maintenance mode: staff can switch it on/off with /maintenance or by asking the bot.
// On: members lose access to every channel (what's removed is recorded), @everyone loses View Channels,
// and only the maintenance channel is visible. Off: everything recorded is put back exactly.
const MAINT_CHANNEL_ID = process.env.MAINT_CHANNEL_ID || "";
const MAINT_FILE = path.join(here, "maintenance.json");
const LOCK_ROLE_IDS = () => MEMBER_ROLE_IDS.filter((id) => id !== STAFF_ROLE_ID); // member roles hidden during maintenance
const MAINT_TOOL = {
  name: "set_maintenance",
  description: "Turn the server's maintenance mode on or off, when someone who runs the server asks to (e.g. 'turn off maintenance mode', 'put the server in maintenance').",
  input_schema: {
    type: "object",
    properties: { mode: { type: "string", enum: ["on", "off"] } },
    required: ["mode"],
    additionalProperties: false,
  },
  strict: true,
};
const MAINT_ON = `\n- This person helps run the server. If they ask to turn maintenance mode on or off, call set_maintenance.`;
// Server updates: staff give rough notes (/update, or asking the bot); the bot writes a versioned post,
// previews it in the staff channel with Post/Discard buttons, and posts it silently (no pings, no notification).
const UPDATES_CHANNEL_ID = process.env.UPDATES_CHANNEL_ID || "";
const UPDATES_FILE = path.join(here, "updates.json"); // { version, drafts: { id: { text, version } } }
const UPDATE_TOOL = {
  name: "post_server_update",
  description: "Draft a server update post from the notes of someone who runs the server, when they ask to post, write or announce a server update or changelog.",
  input_schema: {
    type: "object",
    properties: {
      notes: { type: "string", description: "Everything they said changed, in their words." },
      bump: { type: "string", enum: ["minor", "major"], description: "major only if they say it's a big/major update or a new version number" },
    },
    required: ["notes", "bump"],
    additionalProperties: false,
  },
  strict: true,
};
const UPDATE_ON = `\n- This person helps run the server. If they ask to post a server update or changelog, call post_server_update with their notes.`;
// Media requests: members ask for a film or show with a form; it's approved in the staff channel, downloads into the
// hidden shared folders, and the watch link is posted in the title's post in the cinema forum.
const MEDIA_REQUESTS_CHANNEL_ID = process.env.MEDIA_REQUESTS_CHANNEL_ID || "";
const MEDIA_FORUM_ID = process.env.MEDIA_FORUM_ID || "";
const SEERR_URL = (process.env.SEERR_URL || "").replace(/\/+$/, "");
const RADARR_URL = (process.env.RADARR_URL || "").replace(/\/+$/, "");
const SONARR_URL = (process.env.SONARR_URL || "").replace(/\/+$/, "");
const SHARE_URL = (process.env.SHARE_URL || "").replace(/\/+$/, "");
const MEDIA_ON = Boolean(MEDIA_REQUESTS_CHANNEL_ID && MEDIA_FORUM_ID && SEERR_URL && process.env.SEERR_API_KEY && RADARR_URL &&
  process.env.RADARR_API_KEY && SONARR_URL && process.env.SONARR_API_KEY && SHARE_URL && process.env.SHARE_TOKEN);
const MEDIA_HINT = `\n- If someone asks you to get, download or add a film or show, tell them to use /request or the button in <#${MEDIA_REQUESTS_CHANNEL_ID}>. You can't request it yourself.`;
// Game tags: every post in the games forum gets a ping role; reacting with the post's title emoji
// (or TAG_EMOJI if it has none) on its first message gives you the role, removing it takes it away.
const GAMES_FORUM_ID = process.env.GAMES_FORUM_ID || "";
const TAG_EMOJI = "🔔";                         // fallback when a post title has no emoji
const TAGS_FILE = path.join(here, "tags.json"); // forum post id -> { roleId, emoji, noted, noteId }
const MAX_TOKENS = 1200;
const HISTORY_MESSAGES = 10;    // recent channel messages sent as context
const USER_COOLDOWN_MS = 15_000; // per person, between questions
const DAILY_LIMIT = 200;         // questions per day across the whole server
// Web research: up to 3 searches and 2 page fetches per question, paid from a daily budget.
const SEARCH_BUDGET_USD = 0.15;  // per day, across the whole server (worst case ~$4.50/month)
const RESEARCH_PER_PERSON = 3;   // researched questions per person per day
const RESEARCH_TOOLS = [
  { type: "web_search_20250305", name: "web_search", max_uses: 3 }, // the dynamic-filtering version doesn't run on Haiku 5.5
  { type: "web_fetch_20250910", name: "web_fetch", max_uses: 2, max_content_tokens: 4000 },
];
// Haiku 5.5 prices in USD (only used for the running cost estimate and the search budget).
const PRICE_IN = 0.10 / 1e6;
const PRICE_OUT = 0.50 / 1e6;
const PRICE_SEARCH = 0.01;

const SEARCH_ON = `\n- You can research online: up to 3 web searches, and you can open up to 2 pages with web_fetch to check a source (such as the official site, patch notes or a channel page). Only do this when the answer depends on recent or changing information (patch notes, release dates, news, results, new uploads, prices) and you aren't confident without it; otherwise answer from what you know. Prefer primary sources. Stop as soon as you have the answer.`;
const SEARCH_OFF = `\n- Web search isn't available right now (today's search limit is used up). If the question needs current information, answer from what you know and say you couldn't check online today.`;

function systemPrompt(botName, serverName, canSearch) {
  return `You are ${botName}, the assistant in the Discord server "${serverName}".
${SERVER_INFO ? `\nAbout this server: ${SERVER_INFO}\n` : ""}
How to reply:
- This is Discord chat. How to talk: ${PERSONALITY}
- Be as short and precise as possible: one or two sentences unless they ask for detail. Give the answer and nothing else. Never mention how or where you looked, what you checked or didn't check, or when something was posted unless asked. No "I couldn't confirm", no suggestions to check elsewhere, no extra context, and never say the same thing twice.
- For a lookup (a video, link, page, IP, date, score, price or patch), reply with just the answer on one line. Example: "what's MKBHD's latest video?" → **WTF is a Googlebook?** https://youtu.be/_0G4OG39XjI . Always include the plain link when the answer is a specific video, article or page.
- Only add a caveat if the answer is probably wrong, in a few words.
- Use Discord markdown sparingly (bold, lists, code blocks for commands or configs). Facts, IPs and steps always stay clear and accurate.
- Never try to ping @everyone, @here or roles.
- You'll be shown recent messages from the channel for context. Answer the latest question; use the earlier messages only to understand it.
- You don't know the server's private details (IPs, passwords, whitelists, mod lists) unless they appear in the messages you're shown. Don't make them up; say who to ask instead.${canSearch ? SEARCH_ON : SEARCH_OFF}`;
}

// ---- Clients ----------------------------------------------------------------
// The placeholder only stops the constructor throwing; without a real key the bot never logs in (see the bottom).
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || "missing" });
const discord = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.GuildMembers],
  // Partials let reactions on older (uncached) forum posts still come through.
  partials: [Partials.Message, Partials.Reaction, Partials.User, Partials.Channel, Partials.GuildMember],
  allowedMentions: { parse: [], repliedUser: true }, // the bot can never mass-ping
});

const lastAsked = new Map(); // userId -> timestamp
let day = new Date().toDateString();
let askedToday = 0;
let searchSpentToday = 0;             // USD spent today on questions that used web research
let researchedToday = 0;
const researchByPerson = new Map(); // userId -> researched questions today
let spentUsd = 0;

// ---- Staff alerts -----------------------------------------------------------
// Posts admin notices to the staff channel. Each kind of alert (key) is sent at most once per cooldown,
// so a problem that keeps happening doesn't flood the channel.
const MONTHLY_BUDGET_USD = Number(process.env.MONTHLY_BUDGET_USD) || 0; // warns at 50%, 80% and 100% of this
const SPEND_FILE = path.join(here, "spend.json");
const alertSentAt = new Map();
async function staffAlert(key, text, cooldownMs = 30 * 60_000) {
  if (!STAFF_CHANNEL_ID) return;
  if (Date.now() - (alertSentAt.get(key) ?? 0) < cooldownMs) return;
  alertSentAt.set(key, Date.now());
  try {
    const staff = await discord.channels.fetch(STAFF_CHANNEL_ID);
    await staff.send({ content: text.slice(0, 2000), allowedMentions: { parse: [] } });
  } catch (error) {
    console.error("Couldn't send staff alert:", error.message);
  }
}

// Adds to the running spend estimate, keeps a monthly total on disk, and warns staff as it nears the budget.
function addSpend(cost) {
  spentUsd += cost;
  const month = new Date().toISOString().slice(0, 7);
  let spend;
  try { spend = JSON.parse(fs.readFileSync(SPEND_FILE, "utf8")); } catch { spend = {}; }
  if (spend.month !== month) spend = { month, usd: 0, warned: [] };
  spend.usd += cost;
  if (MONTHLY_BUDGET_USD) {
    for (const pct of [50, 80, 100]) {
      if (spend.usd >= MONTHLY_BUDGET_USD * pct / 100 && !spend.warned.includes(pct)) {
        spend.warned.push(pct);
        staffAlert(`spend-${pct}`, `💸 The bot has used about **${pct}%** of its $${MONTHLY_BUDGET_USD} monthly budget (~$${spend.usd.toFixed(2)} this month, estimated).${pct >= 100 ? " Top up the Claude credit or raise the limit if you want it to keep answering." : ""}`, 0);
      }
    }
  }
  try { fs.writeFileSync(SPEND_FILE, JSON.stringify(spend)); } catch (e) { console.error("Couldn't save spend:", e.message); }
}
const monthSpend = () => { try { return JSON.parse(fs.readFileSync(SPEND_FILE, "utf8")).usd ?? 0; } catch { return 0; } };

// Spam watch: lots of messages in a short time, or someone repeatedly hitting the bot's limits.
const recentMessages = new Map(); // userId -> timestamps
const limitHits = new Map();      // userId -> timestamps
function tooMany(map, userId, windowMs, max) {
  const now = Date.now();
  const list = (map.get(userId) ?? []).filter((t) => now - t < windowMs);
  list.push(now);
  map.set(userId, list);
  return list.length >= max;
}
function noteLimitHit(message, what) {
  if (tooMany(limitHits, message.author.id, 10 * 60_000, 4)) {
    staffAlert(`limits-${message.author.id}`, `🚩 **${displayName(message)}** keeps hitting the bot's limits (${what}) in ${message.channel}.`);
  }
}
let state = "Starting";
let lastError = "";
const startedAt = new Date();

discord.once(Events.ClientReady, (c) => {
  state = `Online as ${c.user.tag}`;
  writeStatus();
  console.log(`Logged in as ${c.user.tag}. Model ${MODEL}, ask channel ${ASK_CHANNEL_ID || "none (mentions only)"}.`);
  if (ROOMS_CATEGORY_ID) setInterval(cleanUpRooms, 60_000);
  if (GAMES_FORUM_ID) setupAllGameTags().catch((e) => console.error("Game tag setup failed:", e.message));
  registerCommands().catch((e) => console.error("Couldn't register slash commands:", e.message));
  if (MEDIA_ON) {
    ensureRequestPanel().catch((e) => console.error("Request panel setup failed:", e.message));
    checkMediaApps();
    setTimeout(checkMediaRequests, 40_000);
    setInterval(checkMediaRequests, MEDIA_CHECK_MS);
  }
  if (STREAMERS.length) {
    console.log(`Live alerts for: ${STREAMERS.join(", ")}`);
    setTimeout(checkStreams, 20_000);
    setInterval(checkStreams, STREAM_CHECK_MS);
  }
  if (PATCH_FEEDS.length) {
    console.log(`Patch notes for: ${PATCH_FEEDS.map((f) => f.name).join(", ")} (checking every ${PATCH_CHECK_MS / 60_000} min)`);
    setTimeout(checkPatchNotes, 30_000);
    setInterval(checkPatchNotes, PATCH_CHECK_MS);
  }
});

// ---- Game tags --------------------------------------------------------------
function loadTags() {
  try { return JSON.parse(fs.readFileSync(TAGS_FILE, "utf8")); } catch { return {}; }
}
function saveTags(tags) {
  try { fs.writeFileSync(TAGS_FILE, JSON.stringify(tags, null, 2)); } catch (e) { console.error("Couldn't save tags:", e.message); }
}
// A role is only treated as a game tag if it's recorded in tags.json, has no permissions, isn't managed by an
// integration and isn't one of the member roles. Everything that grants or pings tags goes through this.
function isSafeTagRole(role) {
  return Boolean(role) && !role.managed && role.permissions.bitfield === 0n && !MEMBER_ROLE_IDS.includes(role.id) && role.id !== role.guild.id;
}
function gameTagRoles(guild, tags = loadTags()) {
  return Object.values(tags).map((t) => guild.roles.cache.get(t.roleId)).filter(isSafeTagRole);
}
// "🦸 Apex Legends" -> "Apex Legends"
const gameNameFromPost = (name) => name.replace(/^[^\p{L}\p{N}]+/u, "").trim();
// "🦸 Apex Legends" -> "🦸"; posts without a leading emoji use the bell.
const emojiFromPost = (name) => name.match(/^\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*/u)?.[0] ?? TAG_EMOJI;
// Discord sometimes drops the invisible variation selector, so compare without it.
const sameEmoji = (a, b) => a?.replace(/️/g, "") === b?.replace(/️/g, "");
const tagNote = (emoji, roleName) => `-# React ${emoji} on this post to follow it and get the @${roleName} tag for pings. Remove it to undo.`;

async function setupAllGameTags() {
  const forum = await discord.channels.fetch(GAMES_FORUM_ID);
  const active = await forum.threads.fetchActive();
  const archived = await forum.threads.fetchArchived({ limit: 100 });
  const threads = [...active.threads.values(), ...archived.threads.values()].filter((t) => t.parentId === GAMES_FORUM_ID);
  // Forget posts that have been deleted, so their old tag can't be handed out any more.
  const tags = loadTags();
  for (const id of Object.keys(tags)) if (!threads.some((t) => t.id === id)) delete tags[id];
  saveTags(tags);
  for (const thread of threads) await setupGameTag(thread).catch((e) => console.error(`Tag setup for ${thread.name}:`, e.message));
}

// Makes sure a forum post has a ping role, its title emoji as a reaction on its first message, and a note saying how it works.
async function setupGameTag(thread) {
  const tags = loadTags();
  const game = gameNameFromPost(thread.name);
  if (!game) return;
  const guild = thread.guild;
  let role = tags[thread.id] && guild.roles.cache.get(tags[thread.id].roleId);
  if (!role) {
    // Only ever reuse a role that's already a game tag, so a post can never be named to hand out a real role
    // (e.g. a post named after the member role can't hand that role out). Otherwise make a fresh, powerless tag.
    const lower = game.toLowerCase();
    role = gameTagRoles(guild, tags).find((r) => r.name.toLowerCase() === lower || lower.startsWith(r.name.toLowerCase() + " "));
    role ??= await guild.roles.create({ name: game.slice(0, 100), mentionable: true, permissions: [], reason: `Game tag for the ${game} post` });
    tags[thread.id] = { roleId: role.id, noted: false };
    saveTags(tags);
    console.log(`[tags] ${thread.name} -> @${role.name}`);
  }

  const starter = await thread.fetchStarterMessage().catch(() => null);
  if (!starter) return;
  const entry = tags[thread.id];
  const emoji = emojiFromPost(thread.name);
  const oldEmoji = entry.emoji ?? (entry.noted ? TAG_EMOJI : null); // older entries used the bell
  if (oldEmoji && !sameEmoji(oldEmoji, emoji)) {
    // The title emoji changed (or this post still has the old bell): swap the reaction and the note.
    await starter.reactions.cache.find((r) => sameEmoji(r.emoji.name, oldEmoji))?.users.remove(discord.user.id).catch(() => {});
    entry.noted = false;
  }
  if (!starter.reactions.cache.find((r) => sameEmoji(r.emoji.name, emoji))?.me) await starter.react(emoji);
  entry.emoji = emoji;
  if (!entry.noted) {
    const note = tagNote(emoji, role.name);
    if (starter.author.id === discord.user.id) {
      const kept = starter.content.split("\n").filter((line) => !line.startsWith("-# React ")).join("\n");
      await starter.edit({ content: `${kept}\n${note}`.slice(0, 2000), allowedMentions: { parse: [] } });
    } else if (entry.noteId) {
      await thread.messages.edit(entry.noteId, { content: note, allowedMentions: { parse: [] } }).catch(() => {});
    } else {
      entry.noteId = (await thread.send({ content: note, allowedMentions: { parse: [] } })).id;
    }
    entry.noted = true;
  }
  saveTags(tags);
}

async function onTagReaction(reaction, user, add) {
  if (user.bot) return;
  if (reaction.partial) await reaction.fetch().catch(() => null);
  const entry = loadTags()[reaction.message.channelId];
  if (!entry || reaction.message.id !== reaction.message.channelId) return; // only the post's first message
  if (!sameEmoji(reaction.emoji.name, entry.emoji ?? TAG_EMOJI)) return;
  const member = await reaction.message.guild.members.fetch(user.id).catch(() => null);
  if (!member) return;
  if (!isSafeTagRole(reaction.message.guild.roles.cache.get(entry.roleId))) {
    return console.error(`Refused to hand out role ${entry.roleId}: it isn't a plain game tag`);
  }
  if (add) await member.roles.add(entry.roleId, "Picked up a game tag").catch((e) => console.error("Tag add failed:", e.message));
  else await member.roles.remove(entry.roleId, "Dropped a game tag").catch((e) => console.error("Tag remove failed:", e.message));

  // Also follow (or unfollow) the post for them, so it shows in their channel list under the forum.
  // Discord adds a small, undeletable "added to the thread" line each time; that's accepted.
  const thread = reaction.message.channel;
  if (!thread?.isThread?.()) return;
  if (thread.archived) await thread.setArchived(false, "Reopening so a member can follow it").catch(() => {});
  if (add) await thread.members.add(user.id).catch((e) => console.error("Follow failed:", e.message));
  else await thread.members.remove(user.id).catch((e) => console.error("Unfollow failed:", e.message));
}

discord.on(Events.ThreadCreate, async (thread, newlyCreated) => {
  if (!newlyCreated || thread.parentId !== GAMES_FORUM_ID || !GAMES_FORUM_ID) return;
  await new Promise((r) => setTimeout(r, 3000)); // give Discord a moment to attach the first message
  await setupGameTag(thread).catch((e) => console.error(`Tag setup for ${thread.name}:`, e.message));
});
discord.on(Events.MessageReactionAdd, (reaction, user) => onTagReaction(reaction, user, true));
discord.on(Events.MessageReactionRemove, (reaction, user) => onTagReaction(reaction, user, false));

// ---- Change requests --------------------------------------------------------
function loadRequests() {
  try { return JSON.parse(fs.readFileSync(REQUESTS_FILE, "utf8")); } catch { return {}; }
}
function saveRequests(requests) {
  try { fs.writeFileSync(REQUESTS_FILE, JSON.stringify(requests, null, 2)); } catch (e) { console.error("Couldn't save requests:", e.message); }
}
const requestsToday = new Map(); // userId -> count (resets with the daily counters)

// Finds the games-forum post for a game name, using the posts the tag system knows about.
async function findGamePost(guild, game) {
  const lower = String(game).toLowerCase().trim();
  for (const id of Object.keys(loadTags())) {
    const thread = await guild.channels.fetch(id).catch(() => null);
    if (!thread) continue;
    const name = gameNameFromPost(thread.name).toLowerCase();
    if (name === lower || name.startsWith(lower + " ") || lower.startsWith(name + " ")) return thread;
  }
  return null;
}

// Steam's logo-free hero art for a game, if it's on Steam. Shown in the approval message so staff can check it.
async function steamArt(game) {
  try {
    const search = await (await fetch(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(game)}&cc=gb&l=english`)).json();
    const hit = search.items?.find((i) => i.name.toLowerCase().replace(/[^a-z0-9]/g, "") === game.toLowerCase().replace(/[^a-z0-9]/g, "")) ?? search.items?.[0];
    if (!hit) return null;
    const url = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${hit.id}/library_hero.jpg`;
    return (await fetch(url, { method: "HEAD" })).ok ? { url, steamName: hit.name } : null;
  } catch { return null; }
}

// Writes the new opening text for a game post from the request, keeping the same layout.
async function draftPostText(game, emoji, details, currentText) {
  const response = await anthropic.messages.create({
    model: MODEL, max_tokens: 800, output_config: { effort: "low" },
    system: "You write the opening message of a game's post in a Discord games forum. Plain, direct British English. Format: a '# <emoji> <Game>' heading, then the key facts in bold labels (e.g. **IP:**, **Password:**, **Modpack:**), then a short numbered 'How to join' list if there are steps. Only include facts you're given; never invent IPs, passwords or links. No closing remarks. Reply with the message text only.",
    messages: [{ role: "user", content: currentText
      ? `Update this post with the change below. Keep everything else the same.\n\nChange: ${details}\n\nCurrent post:\n${currentText}`
      : `Game: ${emoji} ${game}\nInfo: ${details}` }],
  });
  addSpend(response.usage.input_tokens * PRICE_IN + response.usage.output_tokens * PRICE_OUT);
  return response.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim().slice(0, 1800);
}

async function submitChangeRequest(message, { kind, game, emoji, details }) {
  const count = requestsToday.get(message.author.id) ?? 0;
  if (count >= REQUESTS_PER_PERSON) {
    noteLimitHit(message, "the daily request limit");
    return message.reply(`You've sent ${REQUESTS_PER_PERSON} requests today. Try again tomorrow.`);
  }
  requestsToday.set(message.author.id, count + 1);

  const request = { kind, game, emoji, details, by: message.author.id, channelId: message.channelId, messageId: message.id, status: "pending" };
  let preview = "";
  let image = null;
  if (kind === "add_game") {
    if (await findGamePost(message.guild, game)) return message.reply(`There's already a post for ${game} in the games forum.`);
    request.emoji = emoji || "🎮";
    request.text = await draftPostText(game, request.emoji, details);
    image = await steamArt(game);
    request.image = image?.url ?? null;
    preview = `**Post title:** ${request.emoji} ${game}\n**Post text:**\n${request.text}\n**Image:** ${image ? `Steam art for ${image.steamName} (below)` : "none found"}`;
  } else if (kind === "update_game_info" || kind === "remove_game") {
    const post = await findGamePost(message.guild, game);
    if (!post) return message.reply(`I couldn't find a post for ${game} in the games forum.`);
    request.postId = post.id;
    if (kind === "update_game_info") {
      const starter = await post.fetchStarterMessage().catch(() => null);
      if (!starter || starter.author.id !== discord.user.id) {
        // The bot can only edit its own posts, so staff handle this one by hand.
        await postToStaff(message, { ...request, kind: "other" }, details);
        return message.reply("Request sent");
      }
      const kept = starter.content.split("\n").filter((l) => !l.startsWith("-# React ")).join("\n");
      request.text = await draftPostText(game, "", details, kept);
      preview = `**New ${game} post text:**\n${request.text}`;
    } else {
      preview = `**Delete the ${post.name} post and its game tag.**`;
    }
  } else {
    preview = details;
  }
  await postToStaff(message, request, preview, image?.url);
  await message.reply("Request sent");
}

const KIND_LABEL = { add_game: "add a game", update_game_info: "change a game's info", remove_game: "remove a game", other: "a change" };

async function postToStaff(message, request, preview, imageUrl) {
  const staff = await discord.channels.fetch(STAFF_CHANNEL_ID);
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`req:approve:${id}`).setLabel("Approve").setEmoji("✅").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`req:decline:${id}`).setLabel("Decline").setEmoji("❌").setStyle(ButtonStyle.Danger),
  );
  const sent = await staff.send({
    content: `📝 **${displayName(message)}** wants to ${KIND_LABEL[request.kind]}${request.game ? `: **${request.game}**` : ""}\n> ${request.details.replace(/\n/g, "\n> ")}\n${request.kind === "other" ? "" : `\n${preview}`}\n-# Asked in ${message.channel} · ${message.url}`.slice(0, 2000),
    embeds: imageUrl ? [new EmbedBuilder().setImage(imageUrl)] : [],
    components: [row],
    allowedMentions: { parse: [] },
  });
  const requests = loadRequests();
  requests[id] = { ...request, staffMessageId: sent.id, createdAt: Date.now() };
  saveRequests(requests);
  console.log(`[requests] ${message.author.tag}: ${request.kind} ${request.game || ""}`);
}

async function applyRequest(guild, request) {
  if (request.kind === "add_game") {
    const forum = await discord.channels.fetch(GAMES_FORUM_ID);
    await forum.threads.create({
      name: `${request.emoji} ${request.game}`.slice(0, 100),
      message: { content: request.text, files: request.image ? [{ attachment: request.image, name: "game.jpg" }] : [], allowedMentions: { parse: [] } },
      reason: "Approved change request",
    }); // the game tag, emoji reaction and note are added by the ThreadCreate handler
    return `Added **${request.game}** to the games forum.`;
  }
  if (request.kind === "update_game_info") {
    const post = await discord.channels.fetch(request.postId);
    const starter = await post.fetchStarterMessage();
    const note = starter.content.split("\n").filter((l) => l.startsWith("-# React ")).join("\n");
    await starter.edit({ content: `${request.text}${note ? `\n${note}` : ""}`.slice(0, 2000), allowedMentions: { parse: [] } });
    return `Updated the **${request.game}** post.`;
  }
  if (request.kind === "remove_game") {
    const tags = loadTags();
    const role = guild.roles.cache.get(tags[request.postId]?.roleId);
    const post = await discord.channels.fetch(request.postId).catch(() => null);
    await post?.delete("Approved change request");
    if (isSafeTagRole(role)) await role.delete("Approved change request: game removed");
    delete tags[request.postId];
    saveTags(tags);
    return `Removed **${request.game}** and its tag.`;
  }
  return null; // "other": staff do it themselves
}

// ---- Server updates ---------------------------------------------------------
function loadUpdates() {
  try { return JSON.parse(fs.readFileSync(UPDATES_FILE, "utf8")); } catch { return { version: "0.0", drafts: {} }; }
}
function saveUpdates(u) {
  try { fs.writeFileSync(UPDATES_FILE, JSON.stringify(u, null, 2)); } catch (e) { console.error("Couldn't save updates:", e.message); }
}
function nextVersion(current, bump) {
  const [major, minor] = current.split(".").map(Number);
  return bump === "major" ? `${major + 1}.0` : `${major}.${minor + 1}`;
}

async function draftServerUpdate(notes, bump, by) {
  const updates = loadUpdates();
  const version = nextVersion(updates.version, bump);
  const response = await anthropic.messages.create({
    model: MODEL, max_tokens: 900, output_config: { effort: "low" },
    system: "You write short server update posts for a Discord server, in plain, direct British English. Format:\n" +
      `## v${version}: <a short title>\n` +
      "**What's new**\n- one line per change, biggest first\n" +
      "Then, only if something works differently now, **How to use it** with one line per tip.\n" +
      "Only include what's in the notes; don't invent features. No greeting, no sign-off, no @ mentions of people or roles. Under 1500 characters. Reply with the post only.",
    messages: [{ role: "user", content: notes }],
  });
  addSpend(response.usage.input_tokens * PRICE_IN + response.usage.output_tokens * PRICE_OUT);
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim().slice(0, 1900);
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  updates.drafts[id] = { text, version, by };
  saveUpdates(updates);
  const staff = await discord.channels.fetch(STAFF_CHANNEL_ID);
  await staff.send({
    content: `🗒️ **Server update draft** from ${by} (posts silently to <#${UPDATES_CHANNEL_ID}>):\n\n${text}`.slice(0, 2000),
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`upd:post:${id}`).setLabel("Post").setEmoji("📣").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`upd:discard:${id}`).setLabel("Discard").setStyle(ButtonStyle.Secondary),
    )],
    allowedMentions: { parse: [] },
  });
  return `Draft v${version} is in staff chat. Press Post when it looks right.`;
}

async function handleUpdateButton(interaction) {
  if (!isStaff(interaction.member)) return interaction.reply({ content: "You can't do that.", ephemeral: true });
  const [, action, id] = interaction.customId.split(":");
  const updates = loadUpdates();
  const draft = updates.drafts[id];
  if (!draft) return interaction.reply({ content: "That draft has already been dealt with.", ephemeral: true });
  await interaction.deferUpdate();
  let outcome;
  if (action === "post") {
    const channel = await discord.channels.fetch(UPDATES_CHANNEL_ID);
    // Silent: no pings at all, and no notification sound for anyone.
    await channel.send({ content: draft.text, allowedMentions: { parse: [] }, flags: MessageFlags.SuppressNotifications });
    updates.version = draft.version;
    outcome = `📣 Posted as v${draft.version} by ${interaction.member.displayName}.`;
  } else {
    outcome = `Discarded by ${interaction.member.displayName}.`;
  }
  delete updates.drafts[id];
  saveUpdates(updates);
  await interaction.message.edit({ content: `${interaction.message.content}\n**${outcome}**`.slice(0, 2000), components: [] }).catch(() => {});
}

// ---- Maintenance mode -------------------------------------------------------
function loadMaintenance() {
  try { return JSON.parse(fs.readFileSync(MAINT_FILE, "utf8")); } catch { return { on: false, removed: [] }; }
}
function saveMaintenance(state) {
  try { fs.writeFileSync(MAINT_FILE, JSON.stringify(state, null, 2)); } catch (e) { console.error("Couldn't save maintenance state:", e.message); }
}
const isStaff = (member) => Boolean(member?.roles.cache.has(STAFF_ROLE_ID));

// /maintenance and /update, only visible to people who can manage roles (the staff role can), and /request for everyone.
async function registerCommands() {
  const command = new SlashCommandBuilder()
    .setName("maintenance")
    .setDescription("Turn maintenance mode on or off")
    .addStringOption((o) => o.setName("mode").setDescription("on or off").setRequired(true).addChoices({ name: "on", value: "on" }, { name: "off", value: "off" }))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles);
  const update = new SlashCommandBuilder()
    .setName("update")
    .setDescription("Draft a server update post from your notes (previewed in staff chat first)")
    .addStringOption((o) => o.setName("notes").setDescription("What changed, rough notes are fine").setRequired(true))
    .addStringOption((o) => o.setName("bump").setDescription("minor (default) or major version").addChoices({ name: "minor", value: "minor" }, { name: "major", value: "major" }))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles);
  const request = new SlashCommandBuilder().setName("request").setDescription("Request a film or show");
  const staffReady = Boolean(MAINT_CHANNEL_ID && STAFF_ROLE_ID);
  const commands = [
    ...(staffReady ? [command.toJSON()] : []),
    ...(staffReady && UPDATES_CHANNEL_ID ? [update.toJSON()] : []),
    ...(MEDIA_ON ? [request.toJSON()] : []),
  ];
  if (!commands.length) return;
  const channel = await discord.channels.fetch(MAINT_CHANNEL_ID || MEDIA_REQUESTS_CHANNEL_ID);
  await discord.rest.put(Routes.applicationGuildCommands(discord.user.id, channel.guildId), { body: commands });
}

async function setMaintenance(guild, mode, by) {
  const state = loadMaintenance();
  const everyone = guild.roles.everyone;
  const maintChannel = await guild.channels.fetch(MAINT_CHANNEL_ID);
  if (mode === "on") {
    if (state.on) return "Maintenance mode is already on.";
    const removed = [];
    await guild.channels.fetch();
    for (const channel of guild.channels.cache.values()) {
      if (channel.isThread() || channel.id === MAINT_CHANNEL_ID) continue;
      for (const roleId of LOCK_ROLE_IDS()) {
        const ow = channel.permissionOverwrites.cache.get(roleId);
        if (!ow || !ow.allow.has(PermissionFlagsBits.ViewChannel)) continue;
        removed.push({ channelId: channel.id, roleId, allow: ow.allow.bitfield.toString(), deny: ow.deny.bitfield.toString() });
        await ow.delete(`Maintenance mode on (${by})`);
      }
    }
    // Save what was removed straight away, so a crash part-way can still be undone.
    saveMaintenance({ on: true, removed, since: Date.now(), by });
    await everyone.setPermissions(everyone.permissions.remove(PermissionFlagsBits.ViewChannel), `Maintenance mode on (${by})`);
    await maintChannel.permissionOverwrites.edit(everyone, { ViewChannel: true }, { reason: "Maintenance mode on" });
    staffAlert("maintenance", `🚧 Maintenance mode **on** (${by}). The server is hidden from everyone else.`, 0);
    return "Maintenance mode is on. The server is hidden from everyone else now.";
  }
  if (!state.on && everyone.permissions.has(PermissionFlagsBits.ViewChannel)) return "Maintenance mode is already off.";
  for (const r of state.removed ?? []) {
    await discord.rest.put(Routes.channelPermission(r.channelId, r.roleId), { body: { type: 0, allow: r.allow, deny: r.deny }, reason: `Maintenance mode off (${by})` })
      .catch((e) => console.error(`Couldn't restore access on ${r.channelId}:`, e.message));
  }
  await everyone.setPermissions(everyone.permissions.add(PermissionFlagsBits.ViewChannel), `Maintenance mode off (${by})`);
  await maintChannel.permissionOverwrites.edit(STAFF_ROLE_ID, { ViewChannel: true }, { reason: "Maintenance mode off" });
  await maintChannel.permissionOverwrites.edit(everyone, { ViewChannel: false }, { reason: "Maintenance mode off" });
  saveMaintenance({ on: false, removed: [] });
  staffAlert("maintenance", `✅ Maintenance mode **off** (${by}). The server is open again.${UPDATES_CHANNEL_ID ? " Post what changed with `/update`." : ""}`, 0);
  return "Maintenance mode is off. The server is open again.";
}

discord.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand() && interaction.commandName === "update") {
    if (!isStaff(interaction.member)) return interaction.reply({ content: "You can't do that.", ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    const result = await draftServerUpdate(interaction.options.getString("notes"), interaction.options.getString("bump") ?? "minor", interaction.member.displayName)
      .catch((e) => `That didn't work: ${e.message}`);
    return interaction.editReply(result);
  }
  if (!interaction.isChatInputCommand() || interaction.commandName !== "maintenance") return;
  if (!isStaff(interaction.member)) return interaction.reply({ content: "You can't do that.", ephemeral: true });
  await interaction.deferReply({ ephemeral: true });
  try {
    const result = await setMaintenance(interaction.guild, interaction.options.getString("mode"), interaction.member.displayName);
    await interaction.editReply(result);
  } catch (error) {
    console.error("Maintenance toggle failed:", error.message);
    await interaction.editReply(`That didn't work: ${error.message}`);
  }
  writeStatus();
});

discord.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton() && interaction.customId.startsWith("upd:")) return handleUpdateButton(interaction);
  if (!interaction.isButton() || !interaction.customId.startsWith("req:")) return;
  const [, action, id] = interaction.customId.split(":");
  if (!interaction.member?.roles.cache.has(STAFF_ROLE_ID)) {
    return interaction.reply({ content: "You can't approve or decline requests.", ephemeral: true });
  }
  const requests = loadRequests();
  const request = requests[id];
  if (!request || request.status !== "pending") {
    return interaction.reply({ content: "That request has already been dealt with.", ephemeral: true });
  }
  await interaction.deferUpdate();
  let outcome;
  try {
    if (action === "approve") {
      const done = await applyRequest(interaction.guild, request);
      outcome = done ? `✅ Approved by ${interaction.member.displayName}: ${done}` : `✅ Approved by ${interaction.member.displayName}. This one needs doing by hand.`;
      request.status = "approved";
    } else {
      outcome = `❌ Declined by ${interaction.member.displayName}.`;
      request.status = "declined";
    }
  } catch (error) {
    console.error("Applying request failed:", error.message);
    staffAlert(`apply-${id}`, `⚠️ Bot problem: an approved request didn't go through (${error.message.slice(0, 200)}).`, 0);
    outcome = `⚠️ Approved, but it didn't go through: ${error.message}`;
    request.status = "failed";
  }
  requests[id] = request;
  saveRequests(requests);
  await interaction.message.edit({ content: `${interaction.message.content}\n**${outcome}**`.slice(0, 2000), components: [] }).catch(() => {});
  // Let the person who asked know, as a reply to their original message.
  const channel = await discord.channels.fetch(request.channelId).catch(() => null);
  const original = await channel?.messages.fetch(request.messageId).catch(() => null);
  const verdict = request.status === "declined" ? "Request declined" : request.status === "failed" ? "Request approved, but it didn't go through" : "Request approved";
  await (original ? original.reply(verdict) : channel?.send(`<@${request.by}> ${verdict}`))?.catch(() => {});
});

// ---- Game rooms -------------------------------------------------------------
function isMember(member) {
  return Boolean(member) && MEMBER_ROLE_IDS.some((id) => member.roles.cache.has(id));
}

function loadRooms() {
  try { return JSON.parse(fs.readFileSync(ROOMS_FILE, "utf8")); } catch { return {}; }
}
function saveRooms(rooms) {
  try { fs.writeFileSync(ROOMS_FILE, JSON.stringify(rooms, null, 2)); } catch (e) { console.error("Couldn't save rooms:", e.message); }
}

async function createGameRoom(message, { game, public: isPublic }) {
  const name = `🎮 ${String(game).replace(/[^\p{L}\p{N} :'&+-]/gu, "").trim().slice(0, 40) || "Game"}`;
  const rooms = loadRooms();
  const existing = message.guild.channels.cache.find((c) => rooms[c.id] && c.name.toLowerCase() === name.toLowerCase());
  if (existing) return message.reply(`There's already a room for that: ${existing}`);
  if (Object.keys(rooms).length >= MAX_ROOMS) return message.reply(`There are already ${MAX_ROOMS} game rooms open. Use one of those or wait for one to close.`);

  const category = await message.guild.channels.fetch(ROOMS_CATEGORY_ID);
  const view = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.Connect;
  // Members-only rooms copy the category's access; public rooms let everyone see and join.
  const self = { id: discord.user.id, type: OverwriteType.Member, allow: view | PermissionFlagsBits.ManageChannels };
  const overwrites = isPublic
    ? [{ id: message.guild.roles.everyone.id, type: OverwriteType.Role, allow: view }, self]
    : [...category.permissionOverwrites.cache.values()].map((o) => ({ id: o.id, allow: o.allow, deny: o.deny, type: o.type })).concat(self);
  const room = await message.guild.channels.create({
    name, type: ChannelType.GuildVoice, parent: ROOMS_CATEGORY_ID, permissionOverwrites: overwrites,
    reason: `Game room requested by ${message.author.tag}`,
  });
  rooms[room.id] = { name, createdAt: Date.now(), lastActive: Date.now(), by: message.author.id };
  saveRooms(rooms);

  const gameName = name.slice(2).toLowerCase();
  // Ping the matching game tag, if there is one, and only ever a game tag (never a member role or @everyone).
  const tag = gameTagRoles(message.guild).find((r) => r.name.toLowerCase() === gameName || gameName.startsWith(r.name.toLowerCase() + " "));
  await message.reply({
    content: `🔊 ${isPublic ? "Public room" : "Room"} for **${name.slice(2)}** is open: ${room}${tag ? ` ${tag}` : ""}\n-# It closes after 10 minutes empty.`,
    allowedMentions: { roles: tag ? [tag.id] : [], repliedUser: true },
  });
  console.log(`[rooms] ${message.author.tag} opened ${name} (${isPublic ? "public" : "members"})`);
}

async function cleanUpRooms() {
  const rooms = loadRooms();
  let changed = false;
  for (const [id, info] of Object.entries(rooms)) {
    const channel = await discord.channels.fetch(id).catch(() => null);
    if (!channel) { delete rooms[id]; changed = true; continue; }
    if (channel.members.size > 0) { info.lastActive = Date.now(); changed = true; continue; }
    if (Date.now() - info.lastActive > ROOM_EMPTY_MS) {
      await channel.delete("Game room empty for 10 minutes").catch((e) => {
        console.error("Couldn't delete room:", e.message);
        staffAlert(`room-${id}`, `⚠️ Bot problem: couldn't delete the empty game room ${channel} (${e.message.slice(0, 150)}).`, 6 * 60 * 60_000);
      });
      delete rooms[id];
      changed = true;
      console.log(`[rooms] closed ${info.name}`);
    }
  }
  if (changed) saveRooms(rooms);
}

// ---- Live alerts ------------------------------------------------------------
function loadStreams() {
  try { return JSON.parse(fs.readFileSync(STREAMS_FILE, "utf8")); } catch { return {}; }
}
function saveStreams(s) {
  try { fs.writeFileSync(STREAMS_FILE, JSON.stringify(s, null, 2)); } catch (e) { console.error("Couldn't save streams:", e.message); }
}
async function decapi(what, channel) {
  const res = await fetch(`https://decapi.me/twitch/${what}/${encodeURIComponent(channel)}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`decapi ${what} ${res.status}`);
  return (await res.text()).trim();
}

async function checkStreams() {
  const streams = loadStreams();
  for (const channel of STREAMERS) {
    try {
      const uptime = await decapi("uptime", channel);
      // "<name> is offline" when off; an uptime like "1 hour, 3 minutes" when live; anything else is an error.
      const live = !/offline/i.test(uptime) && /\d/.test(uptime) && !/error|not found|invalid/i.test(uptime);
      const s = streams[channel] ?? { live: false, offlineSince: 0 };
      if (live && !s.live) {
        s.live = true;
        if (Date.now() - (s.offlineSince || 0) >= STREAM_REANNOUNCE_MS) s.alert = await announceLive(channel);
      } else if (!live && s.live) {
        s.live = false;
        s.offlineSince = Date.now();
      } else if (!live && s.alert && Date.now() - s.offlineSince >= STREAM_REANNOUNCE_MS) {
        // Offline long enough that coming back counts as a new stream, so the old notice goes.
        await removeLiveAlert(channel, s.alert);
        delete s.alert;
      }
      streams[channel] = s;
    } catch (error) {
      console.error(`Live check failed for ${channel}:`, error.message);
    }
  }
  saveStreams(streams);
}

async function announceLive(channel) {
  const [game, title] = await Promise.all([decapi("game", channel).catch(() => ""), decapi("title", channel).catch(() => "")]);
  const guild = (await discord.channels.fetch(GAMES_FORUM_ID || GAMES_CHAT_ID)).guild;
  const post = game && GAMES_FORUM_ID ? await findGamePost(guild, game) : null;
  const target = post ?? (GAMES_CHAT_ID ? await discord.channels.fetch(GAMES_CHAT_ID) : null);
  if (!target) return;
  const playing = game && !post ? ` playing **${game}**` : "";
  const msg = await target.send({
    content: `🔴 **${channel}** is live${playing}: *${title.replace(/[*_~`|]/g, "").slice(0, 200)}*\nhttps://twitch.tv/${channel}`,
    allowedMentions: { parse: [] },
  });
  console.log(`[live] ${channel} is live (${game || "no game"}) -> ${post ? post.name : "games chat"}`);
  return { channelId: msg.channelId, messageId: msg.id };
}

async function removeLiveAlert(channel, alert) {
  try {
    const where = await discord.channels.fetch(alert.channelId);
    // Messages in an auto-archived forum post can't be deleted until it's reopened.
    if (where.isThread() && where.archived) await where.setArchived(false, "Removing an ended live alert");
    await where.messages.delete(alert.messageId);
    console.log(`[live] ${channel} went offline, removed the alert`);
  } catch (error) {
    // 10003/10008: the post or message is already gone.
    if (![10003, 10008].includes(error.code)) console.error(`Couldn't remove live alert for ${channel}:`, error.message);
  }
}

// ---- Patch notes ------------------------------------------------------------
// Checks each game's Steam announcements. New ones that contain actual game changes get a short
// Claude summary posted in the game's forum post, plus a heads-up in the games chat linking to it.
// On the very first check for a game, only the newest announcement with game changes is posted.
let lastPatch = "";

async function checkPatchNotes() {
  const stateAll = readPatchState();
  for (const feed of PATCH_FEEDS) {
    try {
      const url = `https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${feed.appId}&count=10&maxlength=0&feeds=steam_community_announcements&format=json`;
      const items = (await (await fetch(url)).json()).appnews?.newsitems ?? [];
      const covers = await steamCoverImages(feed.appId);
      const seen = stateAll[feed.appId];
      const remember = (item) => {
        const prev = stateAll[feed.appId];
        stateAll[feed.appId] = {
          date: Math.max(item.date, prev?.date ?? 0),
          gids: [...(prev?.gids ?? []), item.gid].slice(-30),
        };
        writePatchState(stateAll);
      };
      if (!seen) {
        // First check: post the newest announcement that has game changes, and mark everything as seen.
        for (const item of [...items].sort((a, b) => b.date - a.date)) {
          if (await handlePatchItem(feed, item, covers)) break;
        }
        for (const item of items) remember(item);
        continue;
      }
      const fresh = items
        .filter((item) => item.date >= seen.date && !seen.gids?.includes(item.gid))
        .sort((a, b) => a.date - b.date);
      for (const item of fresh) {
        await handlePatchItem(feed, item, covers);
        remember(item);
      }
    } catch (error) {
      console.error(`Patch notes check failed for ${feed.name}:`, error.message);
      staffAlert(`patch-${feed.appId}`, `⚠️ Bot problem: checking ${feed.name} patch notes failed (${error.message.slice(0, 200)}).`, 6 * 60 * 60_000);
    }
  }
}

// Steam's events feed has each announcement's 800x450 cover ("capsule") image; the news API doesn't.
// Returns a map of lower-cased title -> image URL. The two feeds use different ids, so they're matched by title.
async function steamCoverImages(appId) {
  const covers = new Map();
  try {
    const url = `https://store.steampowered.com/events/ajaxgetadjacentpartnerevents/?appid=${appId}&count_before=0&count_after=20&lang_list=0`;
    const events = (await (await fetch(url)).json()).events ?? [];
    for (const event of events) {
      const file = JSON.parse(event.jsondata || "{}").localized_capsule_image?.[0];
      if (!file || !event.clan_steamid) continue;
      const clanAccount = (BigInt(event.clan_steamid) - 103582791429521408n).toString(); // group SteamID64 -> account id
      covers.set(event.event_name.trim().toLowerCase(), `https://clan.akamai.steamstatic.com/images/${clanAccount}/${file}`);
    }
  } catch (error) {
    console.error(`Couldn't get Steam cover images for ${appId}:`, error.message);
  }
  return covers;
}

async function handlePatchItem(feed, item, covers = new Map()) {
  const text = item.contents.replace(/\[\/?(p|b|i|u|h\d|list|olist|\*|url[^\]]*|img[^\]]*|previewyoutube[^\]]*|table|tr|td|th|hr)\]/gi, " ").replace(/\{STEAM_CLAN_IMAGE\}[^\s]*/g, "").replace(/\s+/g, " ").trim();
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 800,
    output_config: { effort: "low" },
    system: "You summarise official game announcements for a Discord gaming chat, in British English.\n" +
      "If the announcement contains actual game changes (patch notes, fixes, balance changes, new content, matchmaking changes or tests), reply with one short overview sentence, then up to 6 bullet points ('- ') with the most important changes. No heading, no preamble, under 900 characters.\n" +
      "If it has no game changes (a trailer, sale, event teaser, anti-cheat ban report, stream or merch), reply with exactly: SKIP",
    messages: [{ role: "user", content: `Game: ${feed.name}\nTitle: ${item.title}\n\n${text.slice(0, 20_000)}` }],
  });
  const cost = response.usage.input_tokens * PRICE_IN + response.usage.output_tokens * PRICE_OUT;
  addSpend(cost);
  const summary = response.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  if (!summary || summary === "SKIP" || response.stop_reason === "refusal") {
    console.log(`[patch] ${feed.name}: skipped "${item.title}" (not game changes), ~$${cost.toFixed(5)}`);
    return false;
  }

  const link = `https://store.steampowered.com/news/app/${feed.appId}/view/${item.gid}`;
  // Sending a message reopens a forum post that Discord has auto-archived.
  const post = await discord.channels.fetch(feed.postId);
  const cover = covers.get(item.title.trim().toLowerCase());
  const sent = await post.send({
    content: `📰 **${item.title}**\n${summary}\n-# Full notes: <${link}>`.slice(0, 2000),
    files: cover ? [{ attachment: cover, name: `patch-notes${path.extname(new URL(cover).pathname) || ".jpg"}` }] : [],
  });
  if (GAMES_CHAT_ID) {
    const chat = await discord.channels.fetch(GAMES_CHAT_ID);
    await chat.send(`📰 New **${feed.name}** patch notes: ${item.title} → ${sent.url}`);
  }
  lastPatch = `${feed.name}: ${item.title} (${new Date().toLocaleString("en-GB")})`;
  writeStatus();
  console.log(`[patch] ${feed.name}: posted "${item.title}", ~$${cost.toFixed(5)}`);
  return true;
}

function readPatchState() {
  try { return JSON.parse(fs.readFileSync(PATCH_STATE_FILE, "utf8")); } catch { return {}; }
}
function writePatchState(stateAll) {
  try { fs.writeFileSync(PATCH_STATE_FILE, JSON.stringify(stateAll, null, 2)); } catch (e) { console.error("Couldn't save patch state:", e.message); }
}

discord.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.inGuild()) return;

  // Spam watch across every channel the bot can see: 8+ messages in 10 seconds.
  if (tooMany(recentMessages, message.author.id, 10_000, 8)) {
    staffAlert(`spam-${message.author.id}`, `🚩 **${displayName(message)}** is sending a lot of messages very fast in ${message.channel}.`);
  }

  const inAskChannel = Boolean(ASK_CHANNEL_ID) && message.channelId === ASK_CHANNEL_ID;
  const mentioned = message.mentions.users.has(discord.user.id);
  if (!inAskChannel && !mentioned) return;

  // Trying to get the bot to mass-ping (it can't, but staff should know someone tried).
  if (/@everyone|@here|ping (every|all)|mass ?ping/i.test(message.content)) {
    staffAlert(`massping-${message.author.id}`, `🚩 **${displayName(message)}** tried to get the bot to mass-ping in ${message.channel}: "${message.cleanContent.slice(0, 200)}"`);
  }

  // Daily cap, reset at midnight.
  const today = new Date().toDateString();
  if (today !== day) { day = today; askedToday = 0; searchSpentToday = 0; researchedToday = 0; researchByPerson.clear(); requestsToday.clear(); }
  if (askedToday >= DAILY_LIMIT) {
    staffAlert("daily-cap", `⚠️ The bot hit its daily limit of ${DAILY_LIMIT} questions, so it's stopped answering until midnight.`, 12 * 60 * 60_000);
    return message.reply("I've hit my question limit for today. Try again tomorrow!");
  }

  // Per-person cooldown.
  const now = Date.now();
  const waitMs = (lastAsked.get(message.author.id) ?? 0) + USER_COOLDOWN_MS - now;
  if (waitMs > 0) {
    noteLimitHit(message, "the cooldown between questions");
    return message.reply(`Give me ${Math.ceil(waitMs / 1000)}s before your next question.`);
  }
  lastAsked.set(message.author.id, now);
  askedToday++;

  const question = cleanContent(message) || "(they just said hi or pinged you)";
  await message.channel.sendTyping().catch(() => {});

  try {
    const context = await recentHistory(message);
    const personResearched = researchByPerson.get(message.author.id) ?? 0;
    const canSearch = searchSpentToday < SEARCH_BUDGET_USD && personResearched < RESEARCH_PER_PERSON;
    const canMakeRooms = Boolean(ROOMS_CATEGORY_ID) && isMember(message.member);
    const canRequest = Boolean(STAFF_CHANNEL_ID && STAFF_ROLE_ID);
    const canMaintain = Boolean(MAINT_CHANNEL_ID) && isStaff(message.member);
    const canUpdate = Boolean(UPDATES_CHANNEL_ID && STAFF_CHANNEL_ID) && isStaff(message.member);
    const tools = [...(canSearch ? RESEARCH_TOOLS : []), ...(canMakeRooms ? [ROOM_TOOL] : []), ...(canRequest ? [REQUEST_TOOL] : []), ...(canMaintain ? [MAINT_TOOL] : []), ...(canUpdate ? [UPDATE_TOOL] : [])];
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      output_config: { effort: "medium" },
      ...(tools.length && { tools }),
      system: systemPrompt(discord.user.username, message.guild.name, canSearch) + (ROOMS_CATEGORY_ID ? (canMakeRooms ? ROOMS_ON : ROOMS_OFF) : "") + (canRequest ? REQUESTS_ON : "") + (canMaintain ? MAINT_ON : "") + (canUpdate ? UPDATE_ON : "") + (MEDIA_ON ? MEDIA_HINT : ""),
      messages: [{
        role: "user",
        content:
          `Today is ${new Date().toDateString()}. Channel: #${message.channel.name}.\n\n` +
          (context ? `Recent messages (oldest first):\n${context}\n\n` : "") +
          `Latest message, from ${displayName(message)}:\n${question}`,
      }],
    }, canSearch ? { headers: { "anthropic-beta": "web-fetch-2025-09-10" } } : undefined);

    const searches = response.usage.server_tool_use?.web_search_requests ?? 0;
    const fetches = response.usage.server_tool_use?.web_fetch_requests ?? 0;
    const cost = response.usage.input_tokens * PRICE_IN + response.usage.output_tokens * PRICE_OUT + searches * PRICE_SEARCH;
    addSpend(cost);
    if (searches || fetches) {
      searchSpentToday += cost;
      researchedToday++;
      researchByPerson.set(message.author.id, personResearched + 1);
    }
    console.log(`[${new Date().toLocaleTimeString()}] ${message.author.tag}: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out, ${searches} search / ${fetches} fetch, ~$${cost.toFixed(5)} (session ~$${spentUsd.toFixed(4)}; today ${askedToday} questions, search budget $${searchSpentToday.toFixed(3)} of $${SEARCH_BUDGET_USD})`);
    writeStatus();

    if (response.stop_reason === "refusal") {
      staffAlert(`refusal-${message.author.id}`, `🚩 The bot refused a request from **${displayName(message)}** in ${message.channel}: "${message.cleanContent.slice(0, 200)}"`);
      return message.reply("Sorry, I can't help with that one.");
    }
    // A game room request: make the room and announce it ourselves; no second Claude call needed.
    const roomCall = response.content.find((b) => b.type === "tool_use" && b.name === ROOM_TOOL.name);
    if (roomCall) return createGameRoom(message, roomCall.input);
    const updateCall = response.content.find((b) => b.type === "tool_use" && b.name === UPDATE_TOOL.name);
    if (updateCall && canUpdate) {
      const result = await draftServerUpdate(updateCall.input.notes, updateCall.input.bump, displayName(message)).catch((e) => `That didn't work: ${e.message}`);
      return message.reply(result);
    }
    const maintCall = response.content.find((b) => b.type === "tool_use" && b.name === MAINT_TOOL.name);
    if (maintCall && canMaintain) {
      const result = await setMaintenance(message.guild, maintCall.input.mode, displayName(message)).catch((e) => `That didn't work: ${e.message}`);
      writeStatus();
      return message.reply(result);
    }
    const requestCall = response.content.find((b) => b.type === "tool_use" && b.name === REQUEST_TOOL.name);
    if (requestCall) return submitChangeRequest(message, requestCall.input);
    const textBlocks = response.content.filter((b) => b.type === "text");
    let text = textBlocks.map((b) => b.text).join("").trim();
    if (!text) text = "I didn't come up with an answer for that. Try rephrasing?";
    if (response.stop_reason === "max_tokens") text += " …";
    // No separate "Sources" line: answers include the relevant link themselves, which keeps replies short.
    await sendReply(message, text);
  } catch (error) {
    console.error("Claude request failed:", error?.status, error?.type ?? "", error?.message);
    lastError = `${new Date().toLocaleString("en-GB")}: ${friendlyError(error)}`;
    writeStatus();
    staffAlert(`claude-${error?.type ?? error?.status ?? "error"}`, `⚠️ Bot problem: ${friendlyError(error)}\n-# ${error?.status ?? ""} ${error?.type ?? ""} ${String(error?.message ?? "").slice(0, 200)}`);
    await message.reply(friendlyError(error)).catch(() => {});
  }
});

// ---- Media requests ---------------------------------------------------------
// A member fills in the form (/request or the button in the requests channel). The bot finds the film or show in
// Seerr and shows the match privately to them to confirm; then it goes to the staff channel with Approve/Decline.
// On approval the bot adds it to Radarr/Sonarr itself, in the hidden shared folders that no Jellyfin user can see,
// so it never shows up on anyone's TV, and makes sure the title has a post in the cinema forum (making one
// if there isn't one). Once it's in Jellyfin, Share makes a 48-hour watch link, posted in that post for anyone
// there to use. When the link expires, staff choose to keep it (moved into the main library) or
// delete it; if nobody chooses, it's deleted. Things that were already in the library are just shared, and are
// never deleted.
const MEDIA_FILE = path.join(here, "media.json"); // { requests: { id: {...} }, posts: { "tv:<tmdb>:<seasons>": postId } }
const MEDIA_PER_WEEK = 3;                         // confirmed requests per person per 7 days (joining someone else's is free)
const MEDIA_LINK_HOURS = 48;
const MEDIA_CHECK_MS = 2 * 60_000;                // how often downloads and link expiry are checked
const MEDIA_DRAFT_MS = 24 * 60 * 60_000;          // matches nobody confirmed are forgotten after this
const MEDIA_CLEANUP_MS = 72 * 60 * 60_000;        // expired downloads nobody chose to keep are deleted after this
const MEDIA_STUCK_MS = 12 * 60 * 60_000;          // staff are told if nothing has started downloading by then
const MEDIA_FORGET_MS = 30 * 24 * 60 * 60_000;    // finished requests are forgotten after this
const QUALITY_PROFILE_ID = Number(process.env.MEDIA_QUALITY_PROFILE_ID) || 4; // HD-1080p, the same as Seerr uses
const SHARED_ROOT = "/downloads/shared/";
const SHARED_FOLDER = { movie: "/downloads/shared/movies", tv: "/downloads/shared/shows" };
const LIBRARY_FOLDER = { movie: "/downloads/movies", animeMovie: "/downloads/anime-movies", tv: "/downloads/shows", animeTv: "/downloads/anime" };
const ARR_TAG = { regular: 1, anime: 2 };         // the indexers are picked by tag: anime only searches Nyaa
const ANIME_KEYWORD = 210024;                     // TMDB's "anime" keyword
const TMDB_IMAGES = "https://image.tmdb.org/t/p/";
const OPEN_STATUSES = ["requested", "approved", "downloading", "ready"];
const MEDIA_STATUS = {
  matching: { colour: 0x8a93a8, footer: "Is this the right one?" },
  requested: { colour: 0x5865f2, footer: "Waiting for approval." },
  approved: { colour: 0x57f287, footer: "Approved. Looking for a download." },
  downloading: { colour: 0xfee75c },
  ready: { colour: 0xeb459e, footer: "Ready to watch." },
  declined: { colour: 0xed4245, footer: "Declined." },
  expired: { colour: 0x4f545c, footer: "The watch link has expired." },
};
const PANEL_TEXT = () => `## 🎬 Film and show requests
Press **Make a request** or use \`/request\`.

**Title:** the name as it's listed, e.g. *The Bear* or *Spirited Away*. Add the **year** if there's more than one with that name.
**Season(s):** shows only, e.g. \`1\`, \`1-3\` or \`all\`. Leave it empty for season 1.

- Check the match and press **That's it**.
- Once it's approved, it gets a post in <#${MEDIA_FORUM_ID}>. You're pinged there with a watch link when it's ready. Links last ${MEDIA_LINK_HOURS} hours.
- If someone has already asked for it, you're added to theirs instead.`;

function loadMedia() {
  try { return JSON.parse(fs.readFileSync(MEDIA_FILE, "utf8")); } catch { return { requests: {} }; }
}
const media = loadMedia(); // kept in memory and saved after every change, so the checks and button presses share it
function saveMedia() {
  try { fs.writeFileSync(MEDIA_FILE, JSON.stringify(media, null, 2)); } catch (e) { console.error("Couldn't save media requests:", e.message); }
}

// One small JSON client for the media apps. Keys go in headers only, never in URLs or errors.
async function mediaApi(base, auth, pathAndQuery, { method = "GET", body } = {}) {
  const res = await fetch(base + pathAndQuery, {
    method, headers: { "Content-Type": "application/json", ...auth },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const detail = typeof data === "string" ? data : data?.message ?? data?.error ?? (Array.isArray(data) ? data.map((d) => d.errorMessage).join("; ") : "");
    const error = new Error(`${method} ${pathAndQuery.split("?")[0]} failed (${res.status}) ${String(detail ?? "").slice(0, 200)}`.trim());
    error.status = res.status;
    throw error;
  }
  return data;
}
const seerr = (p, o) => mediaApi(SEERR_URL, { "X-Api-Key": process.env.SEERR_API_KEY }, p, o);
const radarr = (p, o) => mediaApi(RADARR_URL, { "X-Api-Key": process.env.RADARR_API_KEY }, p, o);
const sonarr = (p, o) => mediaApi(SONARR_URL, { "X-Api-Key": process.env.SONARR_API_KEY }, p, o);
const shareApi = (p, o) => mediaApi(SHARE_URL, { Authorization: `Bearer ${process.env.SHARE_TOKEN}` }, p, o);

// ---- Matching
// "The Bear" and "the bear!" are the same title.
const normTitle = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/&/g, "and")
  .replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, "");
const toCandidate = (r) => ({
  id: r.id, title: r.title ?? r.name, year: Number((r.releaseDate ?? r.firstAirDate ?? "").slice(0, 4)) || null,
  poster: r.posterPath ?? null, backdrop: r.backdropPath ?? null, overview: String(r.overview ?? "").slice(0, 400),
});

async function seerrSearch(query, type) {
  const found = [];
  for (const page of [1, 2]) {
    // Seerr rejects some characters encodeURIComponent leaves alone (e.g. the ' in Ocean's Eleven).
    const q = encodeURIComponent(query).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
    const d = await seerr(`/search?query=${q}&page=${page}&language=en`);
    found.push(...d.results.filter((r) => r.mediaType === type));
    if (page >= d.totalPages || found.length >= 10) break;
  }
  return found.slice(0, 10).map(toCandidate);
}

// Best match first, then the rest in Seerr's order (most popular first), for "Not this one" to step through.
async function findMatches(title, year, type) {
  const byYear = (list) => [...list].sort((a, b) => yearScore(a) - yearScore(b));
  const yearScore = (c) => (!year ? 0 : c.year === year ? 0 : c.year && Math.abs(c.year - year) <= 1 ? 1 : 2);
  const exactFirst = (list, wanted) => {
    const exact = byYear(list.filter((c) => normTitle(c.title) === normTitle(wanted)));
    return exact.length ? [...exact, ...list.filter((c) => !exact.includes(c))] : null;
  };
  let list = await seerrSearch(title, type);
  const exact = exactFirst(list, title);
  if (exact) return exact;
  // No exact title: let Claude pick from the results, or suggest a better search ("the f1 movie" -> "F1").
  const pick = await pickMatchWithClaude(title, year, type, list);
  if (pick.index >= 0 && list[pick.index]) return [list[pick.index], ...list.filter((_, i) => i !== pick.index)];
  if (pick.search && normTitle(pick.search) !== normTitle(title)) {
    list = await seerrSearch(pick.search, type);
    return exactFirst(list, pick.search) ?? byYear(list);
  }
  return byYear(list);
}

async function pickMatchWithClaude(title, year, type, list) {
  const kind = type === "tv" ? "TV show" : "film";
  const options = list.map((c, i) => `${i}. ${c.title}${c.year ? ` (${c.year})` : ""}: ${c.overview.slice(0, 150)}`).join("\n");
  try {
    const response = await anthropic.messages.create({
      model: MODEL, max_tokens: 200, output_config: { effort: "low" },
      system: "You match a member's film or TV request to a search result. Reply with JSON only: {\"index\": <number of the result they mean, or -1 if none fit>, \"search\": \"<if none fit, the official title to search for instead; otherwise empty>\"}",
      messages: [{ role: "user", content: `They asked for a ${kind}: "${title}"${year ? ` from ${year}` : ""}.\n\nSearch results:\n${options || "(none)"}` }],
    });
    addSpend(response.usage.input_tokens * PRICE_IN + response.usage.output_tokens * PRICE_OUT);
    const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const json = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    return { index: Number.isInteger(json.index) ? json.index : -1, search: String(json.search ?? "").slice(0, 100) };
  } catch (error) {
    console.error("Match pick failed:", error.message);
    return { index: -1, search: "" };
  }
}

// "1", "1, 3", "1-3", "all" -> [1], [1, 3], [1, 2, 3], "all". Empty means season 1. null if it can't be read.
function parseSeasons(text) {
  const t = String(text ?? "").toLowerCase().trim();
  if (!t) return [1];
  if (/\ball\b|\bevery/.test(t)) return "all";
  const seasons = new Set();
  for (const part of t.replace(/[a-z]+/g, " ").split(/[,&+/]/)) {
    const m = part.trim().match(/^(\d{1,3})(?:\s*(?:-|–|to)\s*(\d{1,3}))?$/);
    if (!m) { if (part.trim()) return null; continue; }
    const [a, b] = [Number(m[1]), Number(m[2] ?? m[1])];
    for (let n = Math.min(a, b); n <= Math.max(a, b) && seasons.size < 100; n++) seasons.add(n);
  }
  return seasons.size ? [...seasons].sort((a, b) => a - b) : null;
}

function seasonLabel(seasons) {
  if (seasons === "all") return "All seasons";
  if (!seasons?.length) return "";
  const runs = [];
  for (const n of seasons) {
    const last = runs.at(-1);
    if (last && n === last[1] + 1) last[1] = n; else runs.push([n, n]);
  }
  return runs.map(([a, b]) => (a === b ? `S${a}` : `S${a}–${b}`)).join(", ");
}

const isAnime = (details) => Boolean(details.keywords?.some((k) => k.id === ANIME_KEYWORD) ||
  (details.genres?.some((g) => g.id === 16) && ["ja", "zh", "cn"].includes(details.originalLanguage)));

// ---- Requests and limits
const requestCandidate = (req) => req.candidates[req.pick];
const requestTitle = (req) => {
  const c = requestCandidate(req);
  return `${c.title}${c.year ? ` (${c.year})` : ""}`;
};
const requestName = (req) => `${requestTitle(req)}${req.type === "tv" ? ` · ${seasonLabel(req.seasons)}` : ""}`;
const requestPeople = (req) => [req.by, ...req.viewers];
const pingPeople = (req) => ({ content: requestPeople(req).map((id) => `<@${id}>`).join(" "), allowedMentions: { users: requestPeople(req) } });
const newRequestId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function requestsThisWeek(userId) {
  const since = Date.now() - 7 * 86400_000;
  return Object.values(media.requests).filter((r) => r.by === userId && r.confirmedAt > since && r.status !== "declined")
    .map((r) => r.confirmedAt).sort((a, b) => a - b);
}
function weeklyLimitMessage(userId) {
  const used = requestsThisWeek(userId);
  if (used.length < MEDIA_PER_WEEK) return null;
  return `You've used your ${MEDIA_PER_WEEK} requests this week. The next one frees up <t:${Math.ceil((used[0] + 7 * 86400_000) / 1000)}:R>.`;
}

// Another open request for the same film, or for overlapping seasons of the same show.
function findDuplicate(type, tmdbId, seasons, exceptId) {
  return Object.values(media.requests).find((r) => r.id !== exceptId && OPEN_STATUSES.includes(r.status) &&
    r.type === type && r.tmdbId === tmdbId &&
    (type === "movie" || r.seasons === "all" || seasons === "all" || r.seasons.some((n) => seasons.includes(n))));
}

// Adds someone to an existing request (free), and says where they'll hear about it.
function joinRequest(req, userId) {
  if (!requestPeople(req).includes(userId)) {
    req.viewers.push(userId);
    saveMedia();
  }
  if (req.status === "ready") return `**${requestName(req)}** is ready. The watch link is in <#${req.postId}>.`;
  return `**${requestName(req)}** has already been requested, so I've added you to it. You'll be pinged ${req.postId ? `in <#${req.postId}> ` : ""}when it's ready.`;
}

// ---- Cards
// The match: shown privately to the requester to check, and in the staff channel with Approve/Decline.
function matchEmbed(req, { big = false } = {}) {
  const c = requestCandidate(req);
  const embed = new EmbedBuilder()
    .setTitle(requestTitle(req).slice(0, 256))
    .setURL(`https://www.themoviedb.org/${req.type}/${c.id}`)
    .setColor(MEDIA_STATUS[req.status].colour)
    .setFooter({ text: req.status === "downloading" ? `Downloading: ${req.progress ?? 0}%` : MEDIA_STATUS[req.status].footer });
  const overview = c.overview?.length > 300 ? `${c.overview.slice(0, 297)}…` : c.overview ?? "";
  const details = [
    req.type === "tv" ? `Show · ${seasonLabel(req.seasons)}` : "Film",
    ...(req.status !== "matching" ? [`requested by <@${req.by}>`] : []),
    ...(req.viewers.length ? [`+${req.viewers.length} more`] : []),
  ].join(" · ");
  embed.setDescription(`${overview ? `${overview}\n\n` : ""}**${details}**`);
  if (c.poster) embed.setThumbnail(`${TMDB_IMAGES}w342${c.poster}`);
  if (big && c.backdrop) embed.setImage(`${TMDB_IMAGES}w780${c.backdrop}`);
  if (req.notes && req.status !== "matching") embed.addFields({ name: "Notes", value: req.notes.slice(0, 300) });
  return embed;
}

const mediaButton = (action, req, label, style, emoji) =>
  new ButtonBuilder().setCustomId(`media:${action}:${req.id}`).setLabel(label).setStyle(style).setEmoji(emoji);
const buttonRow = (...buttons) => [new ActionRowBuilder().addComponents(buttons)];

function matchPrompt(req) {
  return {
    content: "Is this the one you mean?",
    embeds: [matchEmbed(req, { big: true })],
    components: buttonRow(mediaButton("yes", req, "That's it", ButtonStyle.Success, "✅"), mediaButton("no", req, "Not this one", ButtonStyle.Secondary, "🔄")),
  };
}

// The ready ping in the post: who it's for, what's ready, and a Watch now button with the link.
function readyMessage(req, until) {
  const watch = new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(req.share.url).setLabel("Watch now").setEmoji("▶️");
  return {
    content: `${pingPeople(req).content} **${readyName(req)}** is ready to watch 🍿\n-# The link expires <t:${until}:R>.`,
    components: buttonRow(watch),
    allowedMentions: pingPeople(req).allowedMentions,
  };
}

// The request's cinema post, unarchived so the bot can post in it. The post's opening message already shows the
// title, so the bot only posts there when it's ready.
async function openPost(req) {
  if (!req.postId) return null;
  const thread = await discord.channels.fetch(req.postId).catch(() => null);
  if (!thread) return null;
  if (thread.archived) await thread.setArchived(false, "Posting a watch link").catch(() => {});
  return thread;
}

// ---- Cinema posts
// One post per title: films are "Title (year)", shows just "Title", so every season of a show shares a post.
const cinemaPostName = (req) => {
  const c = requestCandidate(req);
  return (req.type === "tv" ? c.title : `${c.title}${c.year ? ` (${c.year})` : ""}`).slice(0, 100);
};
// What's ready, as said in the post: the post's name plus the seasons, like "The Bear S3–5".
const readyName = (req) => `${cinemaPostName(req)}${req.type === "tv" ? ` ${seasonLabel(req.seasons)}` : ""}`;

// The title's post in the cinema forum: the one the bot made before, one someone made by hand with the same name,
// or a new one with the art and the right tv/film/anime tag.
async function findOrCreateCinemaPost(req) {
  media.posts ??= {};
  const key = `${req.type}:${req.tmdbId}`;
  const known = media.posts[key] ? await discord.channels.fetch(media.posts[key]).catch(() => null) : null;
  if (known) return known;

  const forum = await discord.channels.fetch(MEDIA_FORUM_ID);
  const c = requestCandidate(req);
  const [active, archived] = await Promise.all([forum.threads.fetchActive(), forum.threads.fetchArchived({ limit: 100 })]);
  const threads = [...active.threads.values(), ...archived.threads.values()].filter((t) => t.parentId === forum.id);
  const names = [cinemaPostName(req), c.title, `${c.title}${c.year ? ` (${c.year})` : ""}`].map(normTitle);
  let thread = threads.find((t) => names.includes(normTitle(t.name)));
  if (!thread) {
    const tagName = req.anime ? "anime" : req.type === "tv" ? "tv" : "film";
    const tag = forum.availableTags.find((t) => t.name.toLowerCase() === tagName);
    const art = c.backdrop ? `${TMDB_IMAGES}w1280${c.backdrop}` : c.poster ? `${TMDB_IMAGES}w780${c.poster}` : null;
    thread = await forum.threads.create({
      name: cinemaPostName(req),
      appliedTags: tag ? [tag.id] : [],
      message: {
        content: `**${requestTitle(req)}**${c.overview ? `\n${c.overview}` : ""}`.slice(0, 2000),
        files: art ? [{ attachment: art, name: "art.jpg" }] : [], // the forum's gallery picture comes from this
        allowedMentions: { parse: [] },
      },
      reason: "Approved media request",
    });
  }
  media.posts[key] = thread.id;
  saveMedia();
  return thread;
}

// The how-to with the button, in the requests channel. Made once, and updated if the text changes.
async function ensureRequestPanel() {
  const channel = await discord.channels.fetch(MEDIA_REQUESTS_CHANNEL_ID);
  const payload = {
    content: PANEL_TEXT(),
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("media:new").setLabel("Make a request").setEmoji("🎬").setStyle(ButtonStyle.Primary))],
    allowedMentions: { parse: [] },
  };
  const recent = await channel.messages.fetch({ limit: 20 });
  const panel = recent.find((m) => m.author.id === discord.user.id && m.components[0]?.components.some((c) => c.customId === "media:new"));
  if (panel) {
    if (panel.content !== payload.content) await panel.edit(payload);
    return;
  }
  await channel.send(payload);
}

// ---- Form
const isMemberish = (member) => isMember(member) || isStaff(member);

async function openRequestForm(interaction) {
  if (!isMemberish(interaction.member)) return interaction.reply({ content: "Requests are for members only.", ephemeral: true });
  const limit = weeklyLimitMessage(interaction.user.id);
  if (limit) return interaction.reply({ content: limit, ephemeral: true });
  const text = (id, style, max, required) => new TextInputBuilder().setCustomId(id).setStyle(style).setMaxLength(max).setRequired(required);
  const modal = new ModalBuilder().setCustomId("media:form").setTitle("Request a film or show").addLabelComponents(
    new LabelBuilder().setLabel("Title").setDescription("e.g. The Bear, F1, Spirited Away").setTextInputComponent(text("title", TextInputStyle.Short, 100, true)),
    new LabelBuilder().setLabel("Film or show?").setStringSelectMenuComponent(new StringSelectMenuBuilder().setCustomId("type").setRequired(true)
      .addOptions({ label: "Film", value: "movie", emoji: "🎬" }, { label: "Show", value: "tv", emoji: "📺" })),
    new LabelBuilder().setLabel("Season(s)").setDescription("Shows only: 1, 1-3 or all. Leave empty for season 1.").setTextInputComponent(text("seasons", TextInputStyle.Short, 30, false)),
    new LabelBuilder().setLabel("Year").setDescription("Optional. Helps when there's more than one with that name.").setTextInputComponent(text("year", TextInputStyle.Short, 4, false)),
    new LabelBuilder().setLabel("Notes").setDescription("Optional").setTextInputComponent(text("notes", TextInputStyle.Paragraph, 300, false)),
  );
  return interaction.showModal(modal);
}

async function submitRequestForm(interaction) {
  await interaction.deferReply({ ephemeral: true });
  if (!isMemberish(interaction.member)) return interaction.editReply("Requests are for members only.");
  const limit = weeklyLimitMessage(interaction.user.id);
  if (limit) return interaction.editReply(limit);

  const title = interaction.fields.getTextInputValue("title").trim();
  const type = interaction.fields.getStringSelectValues("type")[0] === "tv" ? "tv" : "movie";
  const yearText = interaction.fields.getTextInputValue("year").trim();
  const year = /^(19|20)\d\d$/.test(yearText) ? Number(yearText) : null;
  const notes = interaction.fields.getTextInputValue("notes").trim();
  const seasons = type === "tv" ? parseSeasons(interaction.fields.getTextInputValue("seasons")) : null;
  if (type === "tv" && !seasons) return interaction.editReply("I couldn't read the seasons. Use something like `1`, `1-3` or `all`.");

  const candidates = await findMatches(title, year, type);
  if (!candidates.length) {
    return interaction.editReply(`I couldn't find a ${type === "tv" ? "show" : "film"} called **${title}**. Check the spelling, or add the year.`);
  }
  const req = { id: newRequestId(), by: interaction.user.id, byName: interaction.member.displayName, type, seasons, notes, candidates, pick: 0, viewers: [], status: "matching", createdAt: Date.now() };
  media.requests[req.id] = req;
  saveMedia();
  return interaction.editReply(matchPrompt(req));
}

// ---- Buttons
async function handleMediaButton(interaction) {
  const [, action, id] = interaction.customId.split(":");
  const req = media.requests[id];
  const reply = (content) => interaction.reply({ content, ephemeral: true });
  if (!req) {
    if (action === "yes" || action === "no") return interaction.update({ content: "This request has expired. Make a new one.", embeds: [], components: [] });
    return reply("This request is closed.");
  }
  const staff = isStaff(interaction.member);

  if (action === "yes" || action === "no") {
    if (interaction.user.id !== req.by) return reply("Only the person who asked can do that.");
    if (req.status !== "matching") return interaction.update({ content: "That's already been sent.", embeds: [], components: [] });
    if (action === "yes") return confirmRequest(interaction, req);
    if (req.pick + 1 >= req.candidates.length) {
      delete media.requests[id];
      saveMedia();
      return interaction.update({ content: "That's all the matches I found. Make a new request with the year or the exact title.", embeds: [], components: [] });
    }
    req.pick++;
    saveMedia();
    return interaction.update(matchPrompt(req));
  }

  if (action === "approve" || action === "decline") {
    if (!staff) return reply("You can't approve or decline requests.");
    if (req.status !== "requested") return reply("That request has already been dealt with.");
    await interaction.deferUpdate();
    const by = interaction.member.displayName;
    const closeCard = (outcome) => interaction.message.edit({ content: `${interaction.message.content}\n**${outcome}**`.slice(0, 2000), components: [] }).catch(() => {});
    if (action === "decline") {
      req.status = "declined";
      req.decidedBy = by;
      req.decidedAt = Date.now();
      saveMedia();
      await closeCard(`❌ Declined by ${by}.`);
      // There's no post for a declined request, so everyone on it hears by DM.
      for (const userId of requestPeople(req)) {
        const user = await discord.users.fetch(userId).catch(() => null);
        await user?.send(`Your request for **${requestName(req)}** was declined.`).catch(() => {});
      }
      return;
    }
    try {
      await startDownload(req);
    } catch (error) {
      console.error("Starting a download failed:", error.message);
      staffAlert(`media-start-${id}`, `⚠️ Bot problem: couldn't start **${requestName(req)}** (${error.message.slice(0, 200)}).`, 0);
      return interaction.followUp({ content: `That didn't work: ${error.message.slice(0, 300)}`, ephemeral: true });
    }
    req.status = "approved";
    req.decidedBy = by;
    req.decidedAt = req.approvedAt = Date.now();
    const thread = await findOrCreateCinemaPost(req);
    req.postId = thread.id;
    saveMedia();
    await closeCard(`✅ Approved by ${by}: ${thread.url}`);
    console.log(`[media] approved ${requestName(req)} (${req.owned ? "already in the library" : req.arr?.added ? "added" : "searching"})`);
    return checkRequest(req).catch((e) => console.error("Request check failed:", e.message));
  }

  if (action === "keep" || action === "delete") {
    if (!staff) return reply("You can't do that.");
    if (req.cleanup?.state !== "pending") return reply("That's already been dealt with.");
    await interaction.deferUpdate();
    return finishCleanup(req, action, interaction.member.displayName);
  }
}

// "That's it": check the seasons, join an existing request if there is one, otherwise send it to staff.
async function confirmRequest(interaction, req) {
  const limit = weeklyLimitMessage(req.by);
  if (limit) return interaction.update({ content: limit, embeds: [], components: [] });
  await interaction.update({ content: "Sending it…", embeds: [], components: [] });
  const tell = (content) => interaction.editReply({ content, embeds: [], components: [] });
  const c = requestCandidate(req);
  if (req.type === "tv") {
    // Check the seasons against what the show actually has ("all" becomes the real list, specials left out).
    const details = await seerr(`/tv/${c.id}`);
    const available = (details.seasons ?? []).filter((s) => s.seasonNumber > 0 && s.episodeCount > 0).map((s) => s.seasonNumber);
    const wanted = req.seasons === "all" ? available : req.seasons.filter((n) => available.includes(n));
    if (!wanted.length) {
      delete media.requests[req.id];
      saveMedia();
      return tell(`${c.title} doesn't have ${seasonLabel(req.seasons)}. It has ${seasonLabel(available) || "no seasons yet"}. Make a new request with the right season.`);
    }
    req.seasons = wanted;
  }
  const duplicate = findDuplicate(req.type, c.id, req.seasons, req.id);
  if (duplicate) {
    delete media.requests[req.id];
    saveMedia();
    return tell(joinRequest(duplicate, req.by));
  }
  if (!STAFF_CHANNEL_ID) throw new Error("STAFF_CHANNEL_ID isn't set, so nobody can approve requests");
  req.tmdbId = c.id;
  req.status = "requested";
  req.confirmedAt = Date.now();
  const staffChannel = await discord.channels.fetch(STAFF_CHANNEL_ID);
  const card = await staffChannel.send({
    content: `🎬 **${req.byName}** requested **${requestName(req)}**`,
    embeds: [matchEmbed(req, { big: true })],
    components: buttonRow(mediaButton("approve", req, "Approve", ButtonStyle.Success, "✅"), mediaButton("decline", req, "Decline", ButtonStyle.Danger, "❌")),
    allowedMentions: { parse: [] },
  });
  req.staffMessageId = card.id;
  saveMedia();
  console.log(`[media] ${req.byName} requested ${requestName(req)}`);
  return tell(`Request sent: **${requestName(req)}**. You'll be pinged when it's ready.`);
}

// ---- Downloading
// Adds the film or show to Radarr/Sonarr in the hidden shared folders, unless it's already in the library.
// Records what the bot added, because only that is ever deleted later.
async function startDownload(req) {
  if (req.type === "movie") {
    const details = await seerr(`/movie/${req.tmdbId}`);
    req.anime = isAnime(details); // also picks the post's anime/film tag
    const found = await shareFind(req);
    if (found && !found.path?.startsWith(SHARED_ROOT)) { req.owned = true; return; }
    const existing = (await radarr(`/movie?tmdbId=${req.tmdbId}`))[0];
    if (existing) {
      // Already in Radarr (wanted by someone, or another request): search for it, but it isn't this request's to delete.
      req.arr = { id: existing.id, added: false, path: existing.path };
      if (!existing.hasFile) await radarr("/command", { method: "POST", body: { name: "MoviesSearch", movieIds: [existing.id] } });
      return;
    }
    // The same fields Seerr sends, but into the hidden shared folder.
    const movie = await radarr("/movie", { method: "POST", body: {
      title: details.title, year: Number(String(details.releaseDate ?? "").slice(0, 4)) || undefined, tmdbId: req.tmdbId,
      qualityProfileId: QUALITY_PROFILE_ID, rootFolderPath: SHARED_FOLDER.movie, monitored: true, minimumAvailability: "released",
      tags: [req.anime ? ARR_TAG.anime : ARR_TAG.regular], addOptions: { searchForMovie: true },
    } });
    req.arr = { id: movie.id, added: true, path: movie.path };
    return;
  }

  const details = await seerr(`/tv/${req.tmdbId}`);
  req.tvdbId = details.externalIds?.tvdbId ?? null;
  req.anime = isAnime(details);
  if (!req.tvdbId) throw new Error("this show has no TVDB id, so Sonarr can't add it");
  const complete = (series, n) => {
    const stats = series.seasons.find((s) => s.seasonNumber === n)?.statistics;
    return Boolean(stats && stats.episodeCount > 0 && stats.episodeFileCount >= stats.episodeCount);
  };
  const existing = (await sonarr(`/series?tvdbId=${req.tvdbId}`))[0];
  if (existing) {
    const missing = req.seasons.filter((n) => !complete(existing, n));
    if (!missing.length) {
      req.owned = !existing.path.startsWith(SHARED_ROOT);
      req.arr = { id: existing.id, added: false, addedSeasons: [], path: existing.path };
      return;
    }
    // Seasons that weren't wanted before count as added by this request (so only those are ever deleted).
    const addedSeasons = missing.filter((n) => !existing.seasons.find((s) => s.seasonNumber === n)?.monitored);
    existing.monitored = true;
    existing.seasons = existing.seasons.map((s) => (req.seasons.includes(s.seasonNumber) ? { ...s, monitored: true } : s));
    await sonarr(`/series/${existing.id}`, { method: "PUT", body: existing });
    for (const n of missing) await sonarr("/command", { method: "POST", body: { name: "SeasonSearch", seriesId: existing.id, seasonNumber: n } });
    req.arr = { id: existing.id, added: false, addedSeasons, path: existing.path };
    return;
  }
  // Not in Sonarr: it might still be in Jellyfin (added by hand).
  const found = await shareFind(req);
  const episodesIn = (n) => details.seasons?.find((s) => s.seasonNumber === n)?.episodeCount ?? Infinity;
  if (found && !found.path?.startsWith(SHARED_ROOT) && req.seasons.every((n) => (found.seasons?.[n] ?? 0) >= episodesIn(n))) {
    req.owned = true;
    return;
  }
  const lookup = (await sonarr(`/series/lookup?term=${encodeURIComponent(`tvdb:${req.tvdbId}`)}`))[0];
  if (!lookup) throw new Error("Sonarr couldn't find this show");
  const series = await sonarr("/series", { method: "POST", body: {
    tvdbId: req.tvdbId, title: lookup.title, qualityProfileId: QUALITY_PROFILE_ID, rootFolderPath: SHARED_FOLDER.tv, seasonFolder: true, monitored: true,
    seriesType: req.anime ? "anime" : "standard", tags: [req.anime ? ARR_TAG.anime : ARR_TAG.regular],
    seasons: lookup.seasons.map((s) => ({ seasonNumber: s.seasonNumber, monitored: req.seasons.includes(s.seasonNumber) })),
    addOptions: { ignoreEpisodesWithFiles: true, searchForMissingEpisodes: true },
  } });
  req.arr = { id: series.id, added: true, addedSeasons: [], path: series.path };
}

// Is it in Jellyfin yet? Share searches every library, including the hidden ones.
async function shareFind(req) {
  for (const query of [`tmdb=${req.tmdbId}`, ...(req.tvdbId ? [`tvdb=${req.tvdbId}`] : [])]) {
    try { return await shareApi(`/find?${query}&type=${req.type}`); } catch (error) { if (error.status !== 404) throw error; }
  }
  return null;
}

// Moves an approved request along: download progress, then a watch link once it's all in Jellyfin.
async function checkRequest(req) {
  let expected = null; // episodes per season Sonarr has, which Jellyfin must have too before the link is made
  if (req.type === "movie" && !req.owned) {
    const movie = await radarr(`/movie/${req.arr.id}`);
    if (!movie.hasFile) return trackProgress(req, await radarr(`/queue/details?movieId=${req.arr.id}`));
  }
  if (req.type === "tv" && !req.owned && req.arr) {
    const series = await sonarr(`/series/${req.arr.id}`);
    const stats = (n) => series.seasons.find((s) => s.seasonNumber === n)?.statistics;
    // Wait for whole seasons, or the link would only have the episodes downloaded so far.
    if (!req.seasons.every((n) => stats(n)?.episodeCount > 0 && stats(n).episodeFileCount >= stats(n).episodeCount)) {
      const queue = await sonarr(`/queue/details?seriesId=${req.arr.id}`);
      return trackProgress(req, queue.filter((q) => req.seasons.includes(q.seasonNumber)));
    }
    expected = Object.fromEntries(req.seasons.map((n) => [n, stats(n).episodeFileCount]));
  }
  const found = await shareFind(req);
  // Downloaded, but Jellyfin hasn't picked it all up yet.
  if (!found || (expected && !req.seasons.every((n) => (found.seasons?.[n] ?? 0) >= expected[n]))) return noteIfStuck(req);
  let link;
  try {
    link = await shareApi("/shares", { method: "POST", body: {
      itemId: found.itemId, season: req.type === "tv" && req.seasons.length === 1 ? req.seasons[0] : null,
      hours: MEDIA_LINK_HOURS, createdBy: discord.user.username, note: `Discord request: ${requestName(req)}`,
    } });
  } catch (error) {
    if (error.status === 409) return; // nothing playable yet
    throw error;
  }
  req.share = { token: link.token, url: link.url, expiresAt: link.expiresAt };
  req.status = "ready";
  req.readyAt = Date.now();
  saveMedia();
  const thread = await openPost(req);
  const until = Math.floor(req.share.expiresAt / 1000);
  const sent = await thread?.send(readyMessage(req, until));
  if (sent) { req.linkMessageId = sent.id; saveMedia(); }
  console.log(`[media] ready: ${requestName(req)}`);
}

async function trackProgress(req, queue) {
  if (queue.length) {
    const size = queue.reduce((t, q) => t + (q.size || 0), 0);
    const left = queue.reduce((t, q) => t + (q.sizeleft || 0), 0);
    const pct = size ? Math.max(0, Math.min(99, Math.floor((1 - left / size) * 100))) : 0;
    req.seenDownloading = true;
    if (req.status !== "downloading" || Math.abs(pct - (req.progress ?? -100)) >= 10) {
      req.status = "downloading";
      req.progress = pct;
      saveMedia();
    }
  } else if (!req.seenDownloading) {
    noteIfStuck(req);
  }
}

// Tells staff once if an approved request still isn't ready after a long time.
function noteIfStuck(req) {
  if (req.stuckAlerted || Date.now() - req.approvedAt < MEDIA_STUCK_MS) return;
  req.stuckAlerted = true;
  saveMedia();
  const hint = req.seenDownloading || req.owned ? "It's downloaded but Jellyfin hasn't picked it up. A library scan might sort it."
    : `It hasn't started downloading, so it may need searching by hand in ${req.type === "tv" ? "Sonarr" : "Radarr"}.`;
  staffAlert(`media-stuck-${req.id}`, `⏳ **${requestName(req)}** was approved ${Math.round(MEDIA_STUCK_MS / 3600_000)} hours ago and still isn't ready. ${hint} <#${req.postId}>`, 0);
}

// ---- Expiry and cleanup
async function expireRequest(req) {
  req.status = "expired";
  const needsCleanup = !req.owned && Boolean(req.arr?.added || req.arr?.addedSeasons?.length);
  if (needsCleanup) req.cleanup = { state: "pending", deadline: Date.now() + MEDIA_CLEANUP_MS };
  saveMedia();
  const thread = await openPost(req); // the post is the title's general post, so it stays open
  if (thread && req.linkMessageId) {
    await thread.messages.edit(req.linkMessageId, { content: `**${readyName(req)}**: the watch link has expired.`, components: [], allowedMentions: { parse: [] } })
      .catch((e) => console.error("Couldn't edit the expired link:", e.message));
  }
  if (!needsCleanup || !STAFF_CHANNEL_ID) return;
  const staffChannel = await discord.channels.fetch(STAFF_CHANNEL_ID);
  const deadline = Math.floor(req.cleanup.deadline / 1000);
  const sent = await staffChannel.send({
    content: `⌛ The watch link for **${requestName(req)}** (asked for by ${req.byName}) has expired. Keep it in the main library, or delete it?\n-# If nobody chooses by <t:${deadline}:f>, it's deleted. <#${req.postId}>`,
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`media:keep:${req.id}`).setLabel("Keep").setEmoji("📥").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`media:delete:${req.id}`).setLabel("Delete").setEmoji("🗑️").setStyle(ButtonStyle.Danger),
    )],
    allowedMentions: { parse: [] },
  });
  req.cleanup.messageId = sent.id;
  saveMedia();
}

async function finishCleanup(req, choice, by) {
  let outcome;
  // Never touch something another open request is still using.
  const other = Object.values(media.requests).find((r) => r !== req && OPEN_STATUSES.includes(r.status) && r.type === req.type && r.arr?.id === req.arr?.id);
  try {
    if (other) outcome = `Left as it is: <#${other.postId}> is still using it.`;
    else outcome = choice === "keep" ? await keepDownload(req) : await deleteDownload(req);
    req.cleanup = { ...req.cleanup, state: choice, by, at: Date.now() };
  } catch (error) {
    console.error("Cleanup failed:", error.message);
    staffAlert(`media-cleanup-${req.id}`, `⚠️ Bot problem: couldn't ${choice} **${requestName(req)}** (${error.message.slice(0, 200)}).`, 0);
    outcome = `That didn't work: ${error.message.slice(0, 200)}`;
    req.cleanup = { ...req.cleanup, state: "failed", by, at: Date.now() };
  }
  saveMedia();
  console.log(`[media] ${choice} ${requestName(req)} (${by}): ${outcome}`);
  if (!req.cleanup.messageId) return;
  const staffChannel = await discord.channels.fetch(STAFF_CHANNEL_ID).catch(() => null);
  const message = await staffChannel?.messages.fetch(req.cleanup.messageId).catch(() => null);
  await message?.edit({ content: `${message.content}\n**${outcome}** (${by})`.slice(0, 2000), components: [] }).catch(() => {});
}

// Moves it out of the hidden folder into the main library, where Jellyfin and Seerr pick it up.
async function keepDownload(req) {
  if (!req.arr.added) return "Kept. The seasons stay with the rest of the show.";
  if (req.type === "movie") {
    await radarr("/movie/editor", { method: "PUT", body: { movieIds: [req.arr.id], rootFolderPath: req.anime ? LIBRARY_FOLDER.animeMovie : LIBRARY_FOLDER.movie, moveFiles: true } });
  } else {
    await sonarr("/series/editor", { method: "PUT", body: { seriesIds: [req.arr.id], rootFolderPath: req.anime ? LIBRARY_FOLDER.animeTv : LIBRARY_FOLDER.tv, moveFiles: true } });
  }
  return "Kept: moved into the main library.";
}

// Deletes only what this request added: the whole film or show if the bot added it (and it's still in the
// shared folder), otherwise just the episode files of the seasons it asked for.
async function deleteDownload(req) {
  const app = req.type === "movie" ? radarr : sonarr;
  const kind = req.type === "movie" ? "movie" : "series";
  if (req.arr.added) {
    const item = await app(`/${kind}/${req.arr.id}`).catch((e) => { if (e.status === 404) return null; throw e; });
    if (!item) return "It was already gone.";
    if (!item.path?.startsWith(SHARED_ROOT)) throw new Error("it isn't in the shared folder any more, so I left it alone");
    await app(`/${kind}/${req.arr.id}?deleteFiles=true`, { method: "DELETE" });
    // Clear it in Seerr too, so it doesn't show as available or processing.
    const details = await seerr(`/${req.type}/${req.tmdbId}`).catch(() => null);
    if (details?.mediaInfo?.id) await seerr(`/media/${details.mediaInfo.id}`, { method: "DELETE" }).catch(() => {});
    return "Deleted.";
  }
  if (req.type === "movie") return "Nothing to delete: it was already in Radarr.";
  const seasons = req.arr.addedSeasons ?? [];
  const files = (await sonarr(`/episodefile?seriesId=${req.arr.id}`)).filter((f) => seasons.includes(f.seasonNumber));
  if (files.length) await sonarr("/episodefile/bulk", { method: "DELETE", body: { episodeFileIds: files.map((f) => f.id) } });
  const series = await sonarr(`/series/${req.arr.id}`);
  series.seasons = series.seasons.map((s) => (seasons.includes(s.seasonNumber) ? { ...s, monitored: false } : s));
  await sonarr(`/series/${req.arr.id}`, { method: "PUT", body: series });
  return `Deleted ${seasonLabel(seasons)} (${files.length} episode${files.length === 1 ? "" : "s"}).`;
}

// On start: can the bot reach each media app with its key? Logged, and staff are told if one can't be reached.
async function checkMediaApps() {
  const checks = {
    Seerr: () => seerr("/auth/me"), Radarr: () => radarr("/system/status"), Sonarr: () => sonarr("/system/status"),
    Share: () => shareApi("/find?tmdb=x&type=movie").catch((e) => { if (e.status !== 400) throw e; }), // 400 = reached, token accepted
  };
  const failed = [];
  for (const [name, check] of Object.entries(checks)) {
    await check().catch((e) => failed.push(`${name} (${e.message.slice(0, 120)})`));
  }
  console.log(`[media] apps: ${failed.length ? `can't reach ${failed.join(", ")}` : "Seerr, Radarr, Sonarr and Share all OK"}`);
  if (failed.length) staffAlert("media-apps", `⚠️ Bot problem: media requests can't reach ${failed.join(", ")}.`, 6 * 60 * 60_000);
}

// Runs every couple of minutes: downloads, link expiry, unanswered cleanups and unconfirmed matches.
let checkingMedia = false;
async function checkMediaRequests() {
  if (checkingMedia) return;
  checkingMedia = true;
  try {
    for (const req of Object.values(media.requests)) {
      try {
        if (req.status === "matching" && Date.now() - req.createdAt > MEDIA_DRAFT_MS) {
          delete media.requests[req.id];
          saveMedia();
        } else if (req.status === "approved" || req.status === "downloading") {
          await checkRequest(req);
        } else if (req.status === "ready" && Date.now() > req.share.expiresAt) {
          await expireRequest(req);
        } else if (req.cleanup?.state === "pending" && Date.now() > req.cleanup.deadline) {
          await finishCleanup(req, "delete", "nobody chose in time");
        } else if (["declined", "expired"].includes(req.status) && req.cleanup?.state !== "pending" &&
          Date.now() - (req.decidedAt ?? req.readyAt ?? req.createdAt) > MEDIA_FORGET_MS) {
          delete media.requests[req.id];
          saveMedia();
        }
      } catch (error) {
        console.error(`Media check for ${req.id} failed:`, error.message);
        staffAlert(`media-${req.id}`, `⚠️ Bot problem with the **${req.candidates?.[req.pick]?.title ?? "?"}** request: ${error.message.slice(0, 200)}`, 6 * 60 * 60_000);
      }
    }
  } finally {
    checkingMedia = false;
    writeStatus();
  }
}

discord.on(Events.InteractionCreate, async (interaction) => {
  if (!MEDIA_ON) return;
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === "request") return await openRequestForm(interaction);
    if (interaction.isButton() && interaction.customId === "media:new") return await openRequestForm(interaction);
    if (interaction.isModalSubmit() && interaction.customId === "media:form") return await submitRequestForm(interaction);
    if (interaction.isButton() && interaction.customId.startsWith("media:")) return await handleMediaButton(interaction);
  } catch (error) {
    console.error("Media request failed:", error.message);
    staffAlert("media-error", `⚠️ Bot problem with a media request: ${error.message.slice(0, 200)}`);
    const reply = { content: "Something went wrong with that. I've flagged it.", ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.followUp(reply).catch(() => {});
    else await interaction.reply(reply).catch(() => {});
  }
});

// Members leaving.
discord.on(Events.GuildMemberRemove, (member) => {
  if (member.user.bot) return;
  const joined = member.joinedAt ? ` (joined ${member.joinedAt.toLocaleDateString("en-GB")})` : "";
  staffAlert(`leave-${member.id}`, `📤 **${member.displayName ?? member.user.username}** (@${member.user.username}) left the server${joined}.`, 0);
});

// ---- Helpers ----------------------------------------------------------------
function displayName(message) {
  return message.member?.displayName ?? message.author.globalName ?? message.author.username;
}

// Message text with the bot's own @mention removed and other mentions shown as names.
function cleanContent(message) {
  const names = new Set([discord.user.username, message.guild.members.me?.displayName].filter(Boolean));
  let text = message.cleanContent;
  for (const name of names) text = text.split(`@${name}`).join("");
  return text.trim();
}

async function recentHistory(message) {
  const fetched = await message.channel.messages.fetch({ limit: HISTORY_MESSAGES, before: message.id }).catch(() => null);
  if (!fetched) return "";
  return [...fetched.values()]
    .reverse()
    .filter((m) => m.cleanContent.trim())
    .map((m) => `${m.author.id === discord.user.id ? `${discord.user.username} (you)` : displayName(m)}: ${m.cleanContent.slice(0, 500)}`)
    .join("\n");
}

// Discord messages max out at 2000 characters.
async function sendReply(message, text) {
  const chunks = text.match(/[\s\S]{1,1900}(?=\s|$)|[\s\S]{1,1900}/g) ?? [text];
  await message.reply(chunks[0]);
  for (const chunk of chunks.slice(1)) await message.channel.send(chunk);
}

function friendlyError(error) {
  if (error instanceof Anthropic.AuthenticationError) return `My API key isn't working. Someone tell ${OWNER_NAME}!`;
  if (error instanceof Anthropic.RateLimitError) return "I'm getting too many questions right now. Try again in a minute.";
  if (error instanceof Anthropic.APIError) {
    // Out of credit shows up as a billing error (or, on older responses, a 400 mentioning the credit balance).
    if (error.type === "billing_error" || /credit balance/i.test(error.message ?? "")) {
      return `I'm out of credit for now, so I can't answer until ${OWNER_NAME} tops me up.`;
    }
    if (error.type === "overloaded_error" || (error.status ?? 0) >= 500) return "Claude's servers are busy. Try again in a minute.";
  }
  return "Something went wrong answering that. Try again in a bit.";
}

// A tiny HTML page with the bot's state, for the Umbrel app's window. Never includes keys.
function writeStatus() {
  if (!STATUS_FILE) return;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const row = (label, value) => `<tr><th>${label}</th><td>${esc(value)}</td></tr>`;
  const title = esc(discord.user?.username ?? "Discord bot");
  const html = `<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><meta http-equiv=refresh content=30><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#10131c;color:#e8ecf4;font:16px/1.5 system-ui,sans-serif}main{max-width:30rem;padding:2rem 1rem}h1{margin:0 0 1rem;font-size:1.4rem}table{border-collapse:collapse;width:100%}th{text-align:left;color:#8a93a8;font-weight:500;padding:.35rem 1rem .35rem 0;white-space:nowrap;vertical-align:top}td{padding:.35rem 0}.note{color:#8a93a8;font-size:.9rem}code{background:#1c2130;padding:.1rem .3rem;border-radius:.25rem}</style>
</head><body><main><h1>${title}</h1><table>
${row("Status", state)}
${row("Model", MODEL)}
${MAINT_CHANNEL_ID ? row("Maintenance mode", loadMaintenance().on ? "on" : "off") : ""}
${row("Questions today", `${askedToday} of ${DAILY_LIMIT}`)}
${row("Researched questions today", `${researchedToday} (max ${RESEARCH_PER_PERSON} per person)`)}
${row("Search budget today", `~$${searchSpentToday.toFixed(3)} of $${SEARCH_BUDGET_USD.toFixed(2)}`)}
${row("Spent since restart", `~$${spentUsd.toFixed(4)}`)}
${row("Spent this month", `~$${monthSpend().toFixed(2)}${MONTHLY_BUDGET_USD ? ` of $${MONTHLY_BUDGET_USD} budget` : ""}`)}
${row("Running since", startedAt.toLocaleString("en-GB"))}
${MEDIA_ON ? row("Media requests", `${Object.values(media.requests).filter((r) => ["requested", "approved", "downloading", "ready"].includes(r.status)).length} open`) : ""}
${PATCH_FEEDS.length ? row("Patch notes", `${PATCH_FEEDS.map((f) => f.name).join(", ")}; last posted: ${lastPatch || "none since restart"}`) : ""}
${lastError ? row("Last error", lastError) : ""}
</table>
<p class=note>Keys are set in Umbrel: right-click the app &gt; Settings &gt; Advanced &gt; Custom variables, service <code>bot</code>: <code>ANTHROPIC_API_KEY</code> and <code>DISCORD_BOT_TOKEN</code>. Restart the app after changing them.</p>
</main></body></html>`;
  try {
    fs.writeFileSync(STATUS_FILE + ".tmp", html);
    fs.renameSync(STATUS_FILE + ".tmp", STATUS_FILE);
  } catch (e) {
    console.error("Couldn't write status page:", e.message);
  }
}

const missing = ["ANTHROPIC_API_KEY", "DISCORD_BOT_TOKEN"].filter((name) => !process.env[name]);
if (missing.length) {
  // Stay up (instead of crash-looping) so the status page can say what's needed.
  state = `Waiting for keys: ${missing.join(" and ")} not set`;
  console.error(state);
  writeStatus();
  setInterval(() => {}, 1 << 30);
} else {
  writeStatus();
  discord.login(process.env.DISCORD_BOT_TOKEN).catch((error) => {
    state = "Couldn't log in to Discord (check DISCORD_BOT_TOKEN)";
    lastError = error.message;
    console.error(state, error.message);
    writeStatus();
    setTimeout(() => process.exit(1), 60_000); // let Umbrel restart it, but not in a tight loop
  });
}

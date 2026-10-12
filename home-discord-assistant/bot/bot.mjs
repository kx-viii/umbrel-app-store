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
// Run with: npm start

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, EmbedBuilder, Events, GatewayIntentBits,
  MessageFlags, OverwriteType, Partials, PermissionFlagsBits, Routes, SlashCommandBuilder,
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
  description: "Send a request to the staff for approval. Use it when someone asks for something to be added, removed or changed: a game in the games forum, a game's server info (IP, modpack, password, how to join), channels, roles, anything else about the server, or a new feature or change for this bot. Never use it for questions.",
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
const REQUESTS_ON = `\n- You can't change the server yourself. If someone asks for a change (add or remove a game, change server info, channels, roles), call request_change so the staff can approve it.`;
// Maintenance mode: staff can switch it on/off with /maintenance or by asking the bot.
// On: members lose access to every channel (what's removed is recorded), @everyone loses View Channels,
// and only the maintenance channel is visible. Off: everything recorded is put back exactly.
const MAINT_CHANNEL_ID = process.env.MAINT_CHANNEL_ID || "";
const MAINT_FILE = path.join(here, "maintenance.json");
const LOCK_ROLE_IDS = () => MEMBER_ROLE_IDS.filter((id) => id !== STAFF_ROLE_ID); // member roles hidden during maintenance
const MAINT_TOOL = {
  name: "set_maintenance",
  description: "Turn the server's maintenance mode on or off, when a staff member asks to (e.g. 'turn off maintenance mode', 'put the server in maintenance').",
  input_schema: {
    type: "object",
    properties: { mode: { type: "string", enum: ["on", "off"] } },
    required: ["mode"],
    additionalProperties: false,
  },
  strict: true,
};
const MAINT_ON = `\n- This person is staff. If they ask to turn maintenance mode on or off, call set_maintenance.`;
// Server updates: staff give rough notes (/update, or asking the bot); the bot writes a versioned post,
// previews it in the staff channel with Post/Discard buttons, and posts it silently (no pings, no notification).
const UPDATES_CHANNEL_ID = process.env.UPDATES_CHANNEL_ID || "";
const UPDATES_FILE = path.join(here, "updates.json"); // { version, drafts: { id: { text, version } } }
const UPDATE_TOOL = {
  name: "post_server_update",
  description: "Draft a server update post from a staff member's notes, when they ask to post, write or announce a server update or changelog.",
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
const UPDATE_ON = `\n- This person is staff. If they ask to post a server update or changelog, call post_server_update with their notes.`;
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
  if (MAINT_CHANNEL_ID && STAFF_ROLE_ID) registerCommands().catch((e) => console.error("Couldn't register /maintenance:", e.message));
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
  if (!isStaff(interaction.member)) return interaction.reply({ content: "Only staff can do that.", ephemeral: true });
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

// /maintenance, only visible to people who can manage roles (the staff role can).
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
  const channel = await discord.channels.fetch(MAINT_CHANNEL_ID);
  const commands = [command.toJSON(), ...(UPDATES_CHANNEL_ID ? [update.toJSON()] : [])];
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
    staffAlert("maintenance", `🚧 Maintenance mode **on** (${by}). Only staff can see the server.`, 0);
    return "Maintenance mode is on. Only staff can see the server now.";
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
    if (!isStaff(interaction.member)) return interaction.reply({ content: "Only staff can do that.", ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    const result = await draftServerUpdate(interaction.options.getString("notes"), interaction.options.getString("bump") ?? "minor", interaction.member.displayName)
      .catch((e) => `That didn't work: ${e.message}`);
    return interaction.editReply(result);
  }
  if (!interaction.isChatInputCommand() || interaction.commandName !== "maintenance") return;
  if (!isStaff(interaction.member)) return interaction.reply({ content: "Only staff can do that.", ephemeral: true });
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
    return interaction.reply({ content: "Only staff can approve or decline requests.", ephemeral: true });
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
      outcome = done ? `✅ Approved by ${interaction.member.displayName}: ${done}` : `✅ Approved by ${interaction.member.displayName}. Staff will sort it.`;
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
      system: systemPrompt(discord.user.username, message.guild.name, canSearch) + (ROOMS_CATEGORY_ID ? (canMakeRooms ? ROOMS_ON : ROOMS_OFF) : "") + (canRequest ? REQUESTS_ON : "") + (canMaintain ? MAINT_ON : "") + (canUpdate ? UPDATE_ON : ""),
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

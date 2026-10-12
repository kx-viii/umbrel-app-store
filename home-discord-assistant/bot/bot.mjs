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
//   ROOMS_CATEGORY_ID, MEMBER_ROLE_IDS     game rooms: the category temporary voice rooms go in, and the
//                                          role ids (comma-separated) allowed to ask for one
// Run with: npm start

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { ChannelType, Client, Events, GatewayIntentBits, OverwriteType, Partials, PermissionFlagsBits } from "discord.js";

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
// Game tags: every post in the games forum gets a ping role; reacting with the post's title emoji
// (or TAG_EMOJI if it has none) on its first message gives you the role, removing it takes it away.
const GAMES_FORUM_ID = process.env.GAMES_FORUM_ID || "";
const TAG_EMOJI = "🔔";                         // fallback when a post title has no emoji
const TAGS_FILE = path.join(here, "tags.json"); // forum post id -> { roleId, emoji, noted, noteId }
const MAX_TOKENS = 2000;
const HISTORY_MESSAGES = 10;    // recent channel messages sent as context
const USER_COOLDOWN_MS = 15_000; // per person, between questions
const DAILY_LIMIT = 200;         // questions per day across the whole server
// Web research: up to 3 searches and 2 page fetches per question, paid from a daily budget.
const SEARCH_BUDGET_USD = 0.15;  // per day, across the whole server (worst case ~$4.50/month)
const RESEARCH_PER_PERSON = 3;   // researched questions per person per day
const RESEARCH_TOOLS = [
  { type: "web_search_20250305", name: "web_search", max_uses: 3 }, // the dynamic-filtering version doesn't run on Haiku 5.5
  { type: "web_fetch_20250910", name: "web_fetch", max_uses: 2, max_content_tokens: 8000 },
];
// Haiku 5.5 prices in USD (only used for the running cost estimate and the search budget).
const PRICE_IN = 0.10 / 1e6;
const PRICE_OUT = 0.50 / 1e6;
const PRICE_SEARCH = 0.01;

const SEARCH_ON = `\n- You can research online: up to 3 web searches, and you can open up to 2 pages with web_fetch to check a source (such as the official site, patch notes or a channel page). Only do this when the answer depends on recent or changing information (patch notes, release dates, news, results, new uploads, prices) and you aren't confident without it; otherwise answer from what you know. Prefer primary sources, and if you still can't confirm something, say so.`;
const SEARCH_OFF = `\n- Web search isn't available right now (today's search limit is used up). If the question needs current information, answer from what you know and say you couldn't check online today.`;

function systemPrompt(botName, serverName, canSearch) {
  return `You are ${botName}, the assistant in the Discord server "${serverName}".
${SERVER_INFO ? `\nAbout this server: ${SERVER_INFO}\n` : ""}
How to reply:
- This is Discord chat. How to talk: ${PERSONALITY}
- Use Discord markdown sparingly (bold, lists, code blocks for commands or configs). Facts, IPs and steps always stay clear and accurate, whatever the tone.
- Never try to ping @everyone, @here or roles.
- You'll be shown recent messages from the channel for context. Answer the latest question; use the earlier messages only to understand it.
- You don't know the server's private details (IPs, passwords, whitelists, mod lists) unless they appear in the messages you're shown. Don't make them up; say who to ask instead.
- If you're unsure or the answer may be out of date (game patches change fast), say so.${canSearch ? SEARCH_ON : SEARCH_OFF}`;
}

// ---- Clients ----------------------------------------------------------------
// The placeholder only stops the constructor throwing; without a real key the bot never logs in (see the bottom).
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || "missing" });
const discord = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessageReactions],
  // Partials let reactions on older (uncached) forum posts still come through.
  partials: [Partials.Message, Partials.Reaction, Partials.User, Partials.Channel],
  allowedMentions: { parse: [], repliedUser: true }, // the bot can never mass-ping
});

const lastAsked = new Map(); // userId -> timestamp
let day = new Date().toDateString();
let askedToday = 0;
let searchSpentToday = 0;             // USD spent today on questions that used web research
let researchedToday = 0;
const researchByPerson = new Map(); // userId -> researched questions today
let spentUsd = 0;
let state = "Starting";
let lastError = "";
const startedAt = new Date();

discord.once(Events.ClientReady, (c) => {
  state = `Online as ${c.user.tag}`;
  writeStatus();
  console.log(`Logged in as ${c.user.tag}. Model ${MODEL}, ask channel ${ASK_CHANNEL_ID || "none (mentions only)"}.`);
  if (ROOMS_CATEGORY_ID) setInterval(cleanUpRooms, 60_000);
  if (GAMES_FORUM_ID) setupAllGameTags().catch((e) => console.error("Game tag setup failed:", e.message));
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
// "🦸 Apex Legends" -> "Apex Legends"
const gameNameFromPost = (name) => name.replace(/^[^\p{L}\p{N}]+/u, "").trim();
// "🦸 Apex Legends" -> "🦸"; posts without a leading emoji use the bell.
const emojiFromPost = (name) => name.match(/^\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*/u)?.[0] ?? TAG_EMOJI;
// Discord sometimes drops the invisible variation selector, so compare without it.
const sameEmoji = (a, b) => a?.replace(/️/g, "") === b?.replace(/️/g, "");
const tagNote = (emoji, roleName) => `-# React ${emoji} on this post to get the @${roleName} tag, so you get pinged when people want to play. Remove it to stop.`;

async function setupAllGameTags() {
  const forum = await discord.channels.fetch(GAMES_FORUM_ID);
  const active = await forum.threads.fetchActive();
  const archived = await forum.threads.fetchArchived({ limit: 100 });
  for (const thread of [...active.threads.values(), ...archived.threads.values()]) {
    if (thread.parentId === GAMES_FORUM_ID) await setupGameTag(thread).catch((e) => console.error(`Tag setup for ${thread.name}:`, e.message));
  }
}

// Makes sure a forum post has a ping role, its title emoji as a reaction on its first message, and a note saying how it works.
async function setupGameTag(thread) {
  const tags = loadTags();
  const game = gameNameFromPost(thread.name);
  if (!game) return;
  const guild = thread.guild;
  let role = tags[thread.id] && guild.roles.cache.get(tags[thread.id].roleId);
  if (!role) {
    const lower = game.toLowerCase();
    role = guild.roles.cache.find((r) => !r.managed && r.mentionable && r.permissions.bitfield === 0n &&
      (r.name.toLowerCase() === lower || lower.startsWith(r.name.toLowerCase() + " ")));
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
  if (add) await member.roles.add(entry.roleId, "Picked up a game tag").catch((e) => console.error("Tag add failed:", e.message));
  else await member.roles.remove(entry.roleId, "Dropped a game tag").catch((e) => console.error("Tag remove failed:", e.message));
}

discord.on(Events.ThreadCreate, async (thread, newlyCreated) => {
  if (!newlyCreated || thread.parentId !== GAMES_FORUM_ID || !GAMES_FORUM_ID) return;
  await new Promise((r) => setTimeout(r, 3000)); // give Discord a moment to attach the first message
  await setupGameTag(thread).catch((e) => console.error(`Tag setup for ${thread.name}:`, e.message));
});
discord.on(Events.MessageReactionAdd, (reaction, user) => onTagReaction(reaction, user, true));
discord.on(Events.MessageReactionRemove, (reaction, user) => onTagReaction(reaction, user, false));

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

  // Ping the matching game tag, if there is one.
  const gameName = name.slice(2).toLowerCase();
  const tag = message.guild.roles.cache.find((r) => r.mentionable && !r.managed && (r.name.toLowerCase() === gameName || gameName.startsWith(r.name.toLowerCase() + " ")));
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
      await channel.delete("Game room empty for 10 minutes").catch((e) => console.error("Couldn't delete room:", e.message));
      delete rooms[id];
      changed = true;
      console.log(`[rooms] closed ${info.name}`);
    }
  }
  if (changed) saveRooms(rooms);
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
          if (await handlePatchItem(feed, item)) break;
        }
        for (const item of items) remember(item);
        continue;
      }
      const fresh = items
        .filter((item) => item.date >= seen.date && !seen.gids?.includes(item.gid))
        .sort((a, b) => a.date - b.date);
      for (const item of fresh) {
        await handlePatchItem(feed, item);
        remember(item);
      }
    } catch (error) {
      console.error(`Patch notes check failed for ${feed.name}:`, error.message);
    }
  }
}

async function handlePatchItem(feed, item) {
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
  spentUsd += cost;
  const summary = response.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  if (!summary || summary === "SKIP" || response.stop_reason === "refusal") {
    console.log(`[patch] ${feed.name}: skipped "${item.title}" (not game changes), ~$${cost.toFixed(5)}`);
    return false;
  }

  const link = `https://store.steampowered.com/news/app/${feed.appId}/view/${item.gid}`;
  // Sending a message reopens a forum post that Discord has auto-archived.
  const post = await discord.channels.fetch(feed.postId);
  const sent = await post.send({ content: `📰 **${item.title}**\n${summary}\n-# Full notes: <${link}>`.slice(0, 2000) });
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

  const inAskChannel = Boolean(ASK_CHANNEL_ID) && message.channelId === ASK_CHANNEL_ID;
  const mentioned = message.mentions.users.has(discord.user.id);
  if (!inAskChannel && !mentioned) return;

  // Daily cap, reset at midnight.
  const today = new Date().toDateString();
  if (today !== day) { day = today; askedToday = 0; searchSpentToday = 0; researchedToday = 0; researchByPerson.clear(); }
  if (askedToday >= DAILY_LIMIT) {
    return message.reply("I've hit my question limit for today. Try again tomorrow!");
  }

  // Per-person cooldown.
  const now = Date.now();
  const waitMs = (lastAsked.get(message.author.id) ?? 0) + USER_COOLDOWN_MS - now;
  if (waitMs > 0) {
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
    const tools = [...(canSearch ? RESEARCH_TOOLS : []), ...(canMakeRooms ? [ROOM_TOOL] : [])];
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      output_config: { effort: "medium" },
      ...(tools.length && { tools }),
      system: systemPrompt(discord.user.username, message.guild.name, canSearch) + (ROOMS_CATEGORY_ID ? (canMakeRooms ? ROOMS_ON : ROOMS_OFF) : ""),
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
    spentUsd += cost;
    if (searches || fetches) {
      searchSpentToday += cost;
      researchedToday++;
      researchByPerson.set(message.author.id, personResearched + 1);
    }
    console.log(`[${new Date().toLocaleTimeString()}] ${message.author.tag}: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out, ${searches} search / ${fetches} fetch, ~$${cost.toFixed(5)} (session ~$${spentUsd.toFixed(4)}; today ${askedToday} questions, search budget $${searchSpentToday.toFixed(3)} of $${SEARCH_BUDGET_USD})`);
    writeStatus();

    if (response.stop_reason === "refusal") {
      return message.reply("Sorry, I can't help with that one.");
    }
    // A game room request: make the room and announce it ourselves; no second Claude call needed.
    const roomCall = response.content.find((b) => b.type === "tool_use" && b.name === ROOM_TOOL.name);
    if (roomCall) return createGameRoom(message, roomCall.input);
    const textBlocks = response.content.filter((b) => b.type === "text");
    let text = textBlocks.map((b) => b.text).join("").trim();
    if (!text) text = "I didn't come up with an answer for that. Try rephrasing?";
    if (response.stop_reason === "max_tokens") text += " …";
    // Up to two sources from search citations, in small text, with <> so Discord doesn't embed them.
    const sources = [...new Set(textBlocks.flatMap((b) => (b.citations ?? []).map((c) => c.url)).filter(Boolean))].slice(0, 2);
    if (sources.length) text += `\n-# Sources: ${sources.map((url) => `<${url}>`).join(" ")}`;
    await sendReply(message, text);
  } catch (error) {
    console.error("Claude request failed:", error?.status, error?.type ?? "", error?.message);
    lastError = `${new Date().toLocaleString("en-GB")}: ${friendlyError(error)}`;
    writeStatus();
    await message.reply(friendlyError(error)).catch(() => {});
  }
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
${row("Questions today", `${askedToday} of ${DAILY_LIMIT}`)}
${row("Researched questions today", `${researchedToday} (max ${RESEARCH_PER_PERSON} per person)`)}
${row("Search budget today", `~$${searchSpentToday.toFixed(3)} of $${SEARCH_BUDGET_USD.toFixed(2)}`)}
${row("Spent since restart", `~$${spentUsd.toFixed(4)}`)}
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

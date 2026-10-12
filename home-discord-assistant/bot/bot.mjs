// A Discord bot that answers questions using Claude.
// Replies to every message in the ask channel (if set), and to @mentions anywhere else.
//
// Everything comes from environment variables, read from ./.env (and ../connector/.env) if present:
//   ANTHROPIC_API_KEY, DISCORD_BOT_TOKEN   required
//   ASK_CHANNEL_ID                         channel it answers everything in (otherwise @mentions only)
//   SERVER_INFO                            a few sentences about the server, added to Claude's instructions
//   OWNER_NAME                             who people should tell when something's wrong
//   MODEL, STATUS_FILE                     optional; STATUS_FILE gets a small HTML status page
// Run with: npm start

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { Client, Events, GatewayIntentBits } from "discord.js";

const here = path.dirname(fileURLToPath(import.meta.url));
for (const file of [path.join(here, ".env"), path.join(here, "..", "connector", ".env")]) {
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

// ---- Settings ---------------------------------------------------------------
const MODEL = process.env.MODEL || "claude-haiku-5-5";
const ASK_CHANNEL_ID = process.env.ASK_CHANNEL_ID || "";
const SERVER_INFO = process.env.SERVER_INFO || "";
const OWNER_NAME = process.env.OWNER_NAME || "the server owner";
const STATUS_FILE = process.env.STATUS_FILE;
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
- This is Discord chat: keep it short and casual, usually a few sentences. Use Discord markdown sparingly (bold, lists, code blocks for commands or configs).
- Never try to ping @everyone, @here or roles.
- You'll be shown recent messages from the channel for context. Answer the latest question; use the earlier messages only to understand it.
- You don't know the server's private details (IPs, passwords, whitelists, mod lists) unless they appear in the messages you're shown. Don't make them up; say who to ask instead.
- If you're unsure or the answer may be out of date (game patches change fast), say so.${canSearch ? SEARCH_ON : SEARCH_OFF}`;
}

// ---- Clients ----------------------------------------------------------------
// The placeholder only stops the constructor throwing; without a real key the bot never logs in (see the bottom).
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || "missing" });
const discord = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
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
});

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
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      output_config: { effort: "medium" },
      ...(canSearch && { tools: RESEARCH_TOOLS }),
      system: systemPrompt(discord.user.username, message.guild.name, canSearch),
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

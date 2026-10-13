// Share: expiring watch links for films and shows in Jellyfin, playable in any browser.
//
// Two web servers:
//   admin  (ADMIN_PORT, 8080)  behind the Umbrel login. A page for making links, plus a JSON API for other apps
//                              (the Discord bot) that needs the token saved in <DATA_DIR>/api-token.
//   public (PUBLIC_PORT, 8081) only /s/<token> watch pages and the streams behind them. This is the one to put on
//                              the internet (Tailscale Funnel).
// Video comes from Jellyfin, converted on the fly to H.264/AAC HLS so it plays in any browser. The Jellyfin key
// stays here: it's sent as a header on every request to Jellyfin and stripped from every playlist that comes back.
// Visitors can only reach the items in their own link, and every stream setting is rebuilt here, not taken from them.
//
// Settings, from the environment or <DATA_DIR>/.env:
//   JELLYFIN_API_KEY   required (Jellyfin > Dashboard > API Keys)
//   PUBLIC_URL         what links start with, e.g. https://<machine>.<tailnet>.ts.net:8443
//   JELLYFIN_URL       default http://jellyfin_server_1:8096
//   SHARE_HOURS        default link lifetime in hours, default 48
//   MAX_BITRATE        video bitrate cap in bits per second, default 8000000

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { adminPage, expiredPage, watchPage } from "./pages.mjs";

const DATA_DIR = process.env.DATA_DIR || "/data";
const ENV_FILE = path.join(DATA_DIR, ".env");
if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const JELLYFIN_URL = (process.env.JELLYFIN_URL || "http://jellyfin_server_1:8096").replace(/\/+$/, "");
const JELLYFIN_API_KEY = process.env.JELLYFIN_API_KEY || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const SHARE_HOURS = Number(process.env.SHARE_HOURS) || 48;
const MAX_BITRATE = Number(process.env.MAX_BITRATE) || 8_000_000;
const ADMIN_PORT = Number(process.env.ADMIN_PORT) || 8080;
const PUBLIC_PORT = Number(process.env.PUBLIC_PORT) || 8081;
const MAX_HOURS = 24 * 7;
const KEEP_EXPIRED_MS = 30 * 86400_000; // expired links stay listed this long, then they're forgotten
const SHARES_FILE = path.join(DATA_DIR, "shares.json");
const TOKEN_FILE = path.join(DATA_DIR, "api-token");
const TEXT_SUBS = new Set(["subrip", "srt", "ass", "ssa", "webvtt", "vtt", "mov_text"]);

if (!JELLYFIN_API_KEY) console.warn("JELLYFIN_API_KEY isn't set: links can't be made or played until it is.");
if (!PUBLIC_URL) console.warn("PUBLIC_URL isn't set: links will only have a path, not a full address.");

// ---- Storage ----------------------------------------------------------------
let API_TOKEN = "";
try { API_TOKEN = fs.readFileSync(TOKEN_FILE, "utf8").trim(); } catch {}
if (!API_TOKEN) {
  API_TOKEN = crypto.randomBytes(24).toString("base64url");
  fs.writeFileSync(TOKEN_FILE, API_TOKEN + "\n", { mode: 0o600 });
}

let shares = {};
try { shares = JSON.parse(fs.readFileSync(SHARES_FILE, "utf8")); } catch {}
function saveNow() {
  const tmp = SHARES_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(shares, null, 1));
  fs.renameSync(tmp, SHARES_FILE);
}
let saveTimer;
const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 2000); };

setInterval(() => {
  const cutoff = Date.now() - KEEP_EXPIRED_MS;
  let changed = false;
  for (const [token, s] of Object.entries(shares)) if (s.expiresAt < cutoff) { delete shares[token]; changed = true; }
  if (changed) saveNow();
}, 3600_000).unref();

const status = (s) => (s.revoked ? "revoked" : Date.now() >= s.expiresAt ? "expired" : "active");
const linkFor = (token) => `${PUBLIC_URL}/s/${token}`;
const summary = (s) => ({
  token: s.token, url: linkFor(s.token), title: s.title, itemId: s.itemId, kind: s.kind, episodes: s.items.length,
  createdAt: s.createdAt, expiresAt: s.expiresAt, status: status(s), views: s.views, lastViewedAt: s.lastViewedAt,
  createdBy: s.createdBy, note: s.note,
});

// ---- Jellyfin ---------------------------------------------------------------
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

function jellyfin(pathAndQuery, { signal, headers = {}, method = "GET" } = {}) {
  return fetch(JELLYFIN_URL + pathAndQuery, {
    method, signal, redirect: "manual",
    headers: { ...headers, Authorization: `MediaBrowser Token="${JELLYFIN_API_KEY}"` },
  });
}
async function jellyfinJson(pathAndQuery) {
  const res = await jellyfin(pathAndQuery);
  if (!res.ok) throw new HttpError(502, `Jellyfin said ${res.status}`);
  return res.json();
}

const normaliseId = (id) => String(id || "").replace(/-/g, "").toLowerCase();
const isId = (id) => /^[0-9a-f]{32}$/.test(id);
const isEnglish = (s) => !s.Language || /^(eng|en)$/i.test(s.Language);
const ITEM_FIELDS = "MediaSources,MediaStreams,ProductionYear";

function toEntry(item) {
  const source = item.MediaSources?.[0] || {};
  const streams = source.MediaStreams || item.MediaStreams || [];
  const audio = streams.filter((s) => s.Type === "Audio");
  // Prefer the default English track; commentary tracks are usually English too, so default wins among them
  const pick = audio.find((s) => s.IsDefault && isEnglish(s)) || audio.find((s) => /^(eng|en)$/i.test(s.Language || "")) || audio.find((s) => s.IsDefault) || audio[0];
  const subs = streams
    .filter((s) => s.Type === "Subtitle" && TEXT_SUBS.has(String(s.Codec).toLowerCase()) && isEnglish(s))
    .slice(0, 4)
    .map((s) => ({
      index: s.Index,
      label: s.IsForced ? "English (forced)" : s.IsHearingImpaired || /sdh/i.test(s.Title || "") ? "English (SDH)" : "English",
    }));
  return {
    id: item.Id, sourceId: source.Id || item.Id, name: item.Name,
    season: item.ParentIndexNumber ?? null, episode: item.IndexNumber ?? null,
    audioIndex: pick?.Index ?? null, subs, size: source.Size || null, container: source.Container || item.Container || null,
  };
}

async function describe(itemId, season) {
  const item = (await jellyfinJson(`/Items?Ids=${itemId}&Fields=${ITEM_FIELDS}`)).Items?.[0];
  if (!item) throw new HttpError(404, "That isn't in the Jellyfin library");
  if (item.Type === "Movie" || item.Type === "Video") {
    return { kind: "movie", title: item.Name, year: item.ProductionYear, posterId: item.Id, items: [toEntry(item)] };
  }
  if (item.Type === "Episode") {
    return { kind: "episode", title: `${item.SeriesName}: ${item.Name}`, seriesName: item.SeriesName, year: item.ProductionYear, posterId: item.SeriesId, items: [toEntry(item)] };
  }
  if (item.Type !== "Series" && item.Type !== "Season") throw new HttpError(400, `Can't share a ${item.Type}`);

  const seriesId = item.Type === "Series" ? item.Id : item.SeriesId;
  let query = `/Shows/${seriesId}/Episodes?Fields=${ITEM_FIELDS}`;
  if (item.Type === "Season") query += `&SeasonId=${item.Id}`;
  else if (season != null) query += `&Season=${Number(season)}`;
  const episodes = (await jellyfinJson(query)).Items.filter((e) => e.LocationType !== "Virtual" && e.MediaSources?.length);
  if (!episodes.length) throw new HttpError(409, "None of it has downloaded yet");

  const seriesName = item.Type === "Series" ? item.Name : item.SeriesName;
  const seasonNumbers = [...new Set(episodes.map((e) => e.ParentIndexNumber))];
  const title = seasonNumbers.length === 1 && seasonNumbers[0] != null
    ? `${seriesName}: ${seasonNumbers[0] === 0 ? "Specials" : `Season ${seasonNumbers[0]}`}`
    : seriesName;
  return { kind: seasonNumbers.length === 1 ? "season" : "series", title, seriesName, year: item.ProductionYear, posterId: seriesId, items: episodes.map(toEntry) };
}

async function createShare(body) {
  const itemId = normaliseId(body.itemId);
  if (!isId(itemId)) throw new HttpError(400, "itemId must be a Jellyfin item id");
  const season = body.season == null || body.season === "" ? null : Number(body.season);
  if (season != null && !Number.isInteger(season)) throw new HttpError(400, "season must be a number");
  const hours = Math.min(MAX_HOURS, Math.max(1, Number(body.hours) || SHARE_HOURS));
  const info = await describe(itemId, season);
  const token = crypto.randomBytes(16).toString("base64url");
  const now = Date.now();
  shares[token] = {
    token, itemId, ...info, createdAt: now, expiresAt: now + hours * 3600_000, revoked: false,
    views: 0, lastViewedAt: null,
    createdBy: String(body.createdBy || "").slice(0, 100), note: String(body.note || "").slice(0, 500),
  };
  saveNow();
  console.log(`link made: ${info.title} (${info.items.length} item${info.items.length === 1 ? "" : "s"}) for ${hours}h by ${shares[token].createdBy || "?"}`);
  return summary(shares[token]);
}

// ---- HTTP helpers -----------------------------------------------------------
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Frame-Options": "DENY",
};
function send(res, code, type, body, headers = {}) {
  res.writeHead(code, { ...SECURITY_HEADERS, "Content-Type": type, "Cache-Control": "no-store", ...headers });
  res.end(body);
}
const json = (res, code, value) => send(res, code, "application/json", JSON.stringify(value));
const notFound = (res) => send(res, 404, "text/plain", "Not found");

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16_384) throw new HttpError(413, "Request too big");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new HttpError(400, "Body must be JSON"); }
}

// Sends a Jellyfin response straight through, keeping only the headers that matter for media
async function pipe(req, res, upstreamPath, { headers = {}, keep = [], method = "GET", rewrite } = {}) {
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  const up = await jellyfin(upstreamPath, { signal: abort.signal, headers, method });
  if (up.status >= 300 && up.status < 400) { up.body?.cancel(); return send(res, 502, "text/plain", "Unexpected redirect"); }
  const out = { ...SECURITY_HEADERS, "Cache-Control": "no-store" };
  for (const h of ["content-type", "content-length", ...keep]) { const v = up.headers.get(h); if (v) out[h] = v; }
  rewrite?.(out);
  res.writeHead(up.status, out);
  if (!up.body || method === "HEAD") return res.end();
  Readable.fromWeb(up.body).on("error", () => res.destroy()).pipe(res);
}

// ---- Public server: watch pages and streams ---------------------------------
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const SESSION_RE = /^[a-f0-9]{8,40}$/;
const PUBLIC_CSP = [
  "default-src 'none'", "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net", "style-src 'unsafe-inline'",
  "img-src 'self'", "media-src 'self' blob:", "connect-src 'self'", "worker-src blob:", "base-uri 'none'", "form-action 'none'",
].join("; ");

function streamParams(share, entry, playSession) {
  const p = new URLSearchParams({
    MediaSourceId: entry.sourceId,
    DeviceId: `share-${share.token.slice(0, 10)}`,
    PlaySessionId: playSession,
    VideoCodec: "h264", AudioCodec: "aac", AudioBitrate: "192000", MaxAudioChannels: "2", TranscodingMaxAudioChannels: "2",
    VideoBitrate: String(MAX_BITRATE), MaxWidth: "1920", MaxHeight: "1080",
    SegmentContainer: "ts", BreakOnNonKeyFrames: "true", EnableAdaptiveBitrateStreaming: "false",
  });
  if (entry.audioIndex != null) p.set("AudioStreamIndex", String(entry.audioIndex));
  return p;
}

// Playlists from Jellyfin only hold relative links, but strip any key that sneaks in anyway
const stripKeys = (text) => text.replace(/([?&])(?:api_key|apikey|ApiKey)=[^&\s#]*(&?)/g, (_, sep, amp) => (amp ? sep : ""));

async function sendPlaylist(res, upstreamPath) {
  const up = await jellyfin(upstreamPath);
  const text = await up.text();
  if (!up.ok) return send(res, up.status === 404 ? 404 : 502, "text/plain", "Stream unavailable");
  send(res, 200, "application/vnd.apple.mpegurl", stripKeys(text));
}

function countView(share, req) {
  if (/bot|crawl|spider|preview|discord|slack|whatsapp|telegram|facebookexternalhit|twitter/i.test(req.headers["user-agent"] || "")) return;
  share.views += 1;
  share.lastViewedAt = Date.now();
  saveSoon();
}

async function handlePublic(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "text/plain", "Method not allowed");
  const url = new URL(req.url, "http://share");
  if (url.pathname === "/health") return send(res, 200, "text/plain", "ok");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "s" || !TOKEN_RE.test(parts[1] || "")) return notFound(res);
  const share = Object.hasOwn(shares, parts[1]) ? shares[parts[1]] : null;
  if (!share) return notFound(res);
  const live = status(share) === "active";
  const [, , section, itemId, ...rest] = parts;

  if (!section) {
    if (!live) return send(res, 410, "text/html; charset=utf-8", expiredPage());
    countView(share, req);
    return send(res, 200, "text/html; charset=utf-8", watchPage(share, PUBLIC_URL), { "Content-Security-Policy": PUBLIC_CSP });
  }
  if (!live) return send(res, 410, "text/plain", "This link has expired");

  if (section === "poster" && !itemId) return pipe(req, res, `/Items/${share.posterId}/Images/Primary?maxHeight=720&quality=85`, { keep: ["cache-control"] });
  if (section === "backdrop" && !itemId) return pipe(req, res, `/Items/${share.posterId}/Images/Backdrop?maxWidth=1920&quality=80`);

  const entry = share.items.find((e) => e.id === itemId);
  if (!entry) return notFound(res);
  const tail = rest.join("/");

  if (section === "v") {
    const playSession = SESSION_RE.test(url.searchParams.get("ps") || url.searchParams.get("PlaySessionId") || "")
      ? (url.searchParams.get("ps") || url.searchParams.get("PlaySessionId"))
      : crypto.createHash("sha256").update(share.token + entry.id).digest("hex").slice(0, 24);
    const params = streamParams(share, entry, playSession);
    if (tail === "master.m3u8") return sendPlaylist(res, `/Videos/${entry.id}/master.m3u8?${params}`);
    if (tail === "main.m3u8") return sendPlaylist(res, `/Videos/${entry.id}/main.m3u8?${params}`);
    const segment = tail.match(/^hls1\/main\/(\d{1,6})\.ts$/);
    if (segment) {
      for (const k of ["runtimeTicks", "actualSegmentLengthTicks"]) {
        const v = url.searchParams.get(k);
        if (v && /^\d{1,15}$/.test(v)) params.set(k, v);
      }
      return pipe(req, res, `/Videos/${entry.id}/hls1/main/${segment[1]}.ts?${params}`);
    }
    return notFound(res);
  }

  if (section === "sub") {
    const index = Number((tail.match(/^(\d{1,3})\.vtt$/) || [])[1]);
    if (!entry.subs.some((s) => s.index === index)) return notFound(res);
    const up = await jellyfin(`/Videos/${entry.id}/${entry.sourceId}/Subtitles/${index}/0/Stream.vtt`);
    if (!up.ok) return send(res, 404, "text/plain", "Subtitles unavailable");
    // Drop leftover styling tags like {\an8} that come across from SRT/ASS files
    const vtt = (await up.text()).replace(/\{\\[^}]*\}/g, "");
    return send(res, 200, "text/vtt; charset=utf-8", vtt);
  }

  if (section === "dl" && !tail) {
    countView(share, req);
    const range = req.headers.range;
    const headers = range && /^bytes=[\d,\s-]+$/.test(range) ? { Range: range } : {};
    return pipe(req, res, `/Items/${entry.id}/Download`, {
      method: req.method, headers, keep: ["content-range", "accept-ranges", "content-disposition", "last-modified", "etag"],
      // Swap the release name ("Film (2026) (1080p BluRay x265 ...) [Group].mkv") for a plain one
      rewrite: (out) => {
        const ext = ((out["content-disposition"] || "").match(/\.([A-Za-z0-9]{2,4})"/) || [])[1] || "mkv";
        const name = share.items.length === 1 && share.kind === "movie"
          ? `${share.title}${share.year ? ` (${share.year})` : ""}`
          : `${share.seriesName || share.title} S${String(entry.season ?? 0).padStart(2, "0")}E${String(entry.episode ?? 0).padStart(2, "0")} ${entry.name}`;
        const clean = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim();
        out["content-disposition"] = `attachment; filename="${clean.replace(/[^\x20-\x7e]/g, "_")}.${ext}"; filename*=UTF-8''${encodeURIComponent(`${clean}.${ext}`)}`;
      },
    });
  }
  return notFound(res);
}

// ---- Admin server: the Umbrel page and the API ------------------------------
function authorised(req) {
  const given = Buffer.from(String(req.headers.authorization || ""));
  const wanted = Buffer.from(`Bearer ${API_TOKEN}`);
  return given.length === wanted.length && crypto.timingSafeEqual(given, wanted);
}

async function handleAdmin(req, res) {
  const url = new URL(req.url, "http://share");
  const p = url.pathname;
  if (req.method === "GET" && p === "/") return send(res, 200, "text/html; charset=utf-8", adminPage(API_TOKEN, PUBLIC_URL, SHARE_HOURS));
  if (p === "/health") return send(res, 200, "text/plain", "ok");
  if (!p.startsWith("/api/")) return notFound(res);
  if (!authorised(req)) return json(res, 401, { error: "Missing or wrong token" });

  // GET /api/search?q=   films and shows in the library
  if (req.method === "GET" && p === "/api/search") {
    const q = (url.searchParams.get("q") || "").trim().slice(0, 100);
    if (!q) return json(res, 200, []);
    const d = await jellyfinJson(`/Items?searchTerm=${encodeURIComponent(q)}&IncludeItemTypes=Movie,Series&Recursive=true&Limit=20&Fields=ProductionYear`);
    return json(res, 200, d.Items.map((i) => ({ id: i.Id, name: i.Name, year: i.ProductionYear, type: i.Type })));
  }
  // GET /api/find?tmdb=<id>|tvdb=<id>&type=movie|tv   is it in Jellyfin yet? Searches every library, including ones
  // no user can see, so other apps can tell when a download has landed. For shows, also counts episodes per season.
  if (req.method === "GET" && p === "/api/find") {
    const type = url.searchParams.get("type") === "tv" ? "Series" : "Movie";
    const tmdb = url.searchParams.get("tmdb") || "", tvdb = url.searchParams.get("tvdb") || "";
    if (!/^\d{1,10}$/.test(tmdb || tvdb)) throw new HttpError(400, "Give tmdb or tvdb as a number");
    const d = await jellyfinJson(`/Items?Recursive=true&IncludeItemTypes=${type}&Fields=ProviderIds,ProductionYear,Path`);
    const hit = d.Items.find((i) => (tmdb && i.ProviderIds?.Tmdb === tmdb) || (tvdb && i.ProviderIds?.Tvdb === tvdb));
    if (!hit) return json(res, 404, { error: "Not in Jellyfin yet" });
    const found = { itemId: hit.Id, name: hit.Name, year: hit.ProductionYear, type: hit.Type, path: hit.Path };
    if (hit.Type === "Series") {
      const episodes = await jellyfinJson(`/Shows/${hit.Id}/Episodes?Fields=MediaSources`);
      found.seasons = {};
      for (const e of episodes.Items) {
        if (e.LocationType === "Virtual" || !e.MediaSources?.length) continue;
        found.seasons[e.ParentIndexNumber ?? 0] = (found.seasons[e.ParentIndexNumber ?? 0] || 0) + 1;
      }
    }
    return json(res, 200, found);
  }
  // GET /api/seasons/<seriesId>   seasons with at least one downloaded episode
  let m = p.match(/^\/api\/seasons\/([0-9a-f-]{32,36})$/i);
  if (req.method === "GET" && m) {
    const seriesId = normaliseId(m[1]);
    const [seasons, episodes] = await Promise.all([
      jellyfinJson(`/Shows/${seriesId}/Seasons`),
      jellyfinJson(`/Shows/${seriesId}/Episodes?Fields=MediaSources`),
    ]);
    const counts = {};
    for (const e of episodes.Items) if (e.LocationType !== "Virtual" && e.MediaSources?.length) counts[e.SeasonId] = (counts[e.SeasonId] || 0) + 1;
    return json(res, 200, seasons.Items.filter((s) => counts[s.Id]).map((s) => ({ id: s.Id, name: s.Name, number: s.IndexNumber, episodes: counts[s.Id] })));
  }
  // GET /api/shares   every link, newest first
  if (req.method === "GET" && p === "/api/shares") {
    return json(res, 200, Object.values(shares).sort((a, b) => b.createdAt - a.createdAt).map(summary));
  }
  // POST /api/shares {itemId, season?, hours?, createdBy?, note?}   make a link
  if (req.method === "POST" && p === "/api/shares") return json(res, 201, await createShare(await readJson(req)));

  m = p.match(/^\/api\/shares\/([A-Za-z0-9_-]{16,64})(\/extend)?$/);
  const share = m && Object.hasOwn(shares, m[1]) ? shares[m[1]] : null;
  if (m && !share) return json(res, 404, { error: "No such link" });
  // GET /api/shares/<token>
  if (req.method === "GET" && share && !m[2]) return json(res, 200, summary(share));
  // DELETE /api/shares/<token>   turn a link off
  if (req.method === "DELETE" && share && !m[2]) {
    share.revoked = true;
    saveNow();
    return json(res, 200, summary(share));
  }
  // POST /api/shares/<token>/extend {hours}   push the expiry back, counted from now
  if (req.method === "POST" && share && m[2]) {
    const hours = Math.min(MAX_HOURS, Math.max(1, Number((await readJson(req)).hours) || SHARE_HOURS));
    share.expiresAt = Date.now() + hours * 3600_000;
    share.revoked = false;
    saveNow();
    return json(res, 200, summary(share));
  }
  return notFound(res);
}

function serve(name, port, handler) {
  http.createServer(async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      if (err.name === "AbortError") return;
      const code = err instanceof HttpError ? err.code : 500;
      if (code >= 500) console.error(`${name}: ${req.method} ${req.url.split("?")[0]}: ${err.message}`);
      if (res.headersSent) return res.destroy();
      json(res, code, { error: code >= 500 && !(err instanceof HttpError) ? "Something went wrong" : err.message });
    }
  }).listen(port, () => console.log(`${name} on port ${port}`));
}

serve("admin", ADMIN_PORT, handleAdmin);
serve("public", PUBLIC_PORT, handlePublic);
process.on("SIGTERM", () => { clearTimeout(saveTimer); saveNow(); process.exit(0); });

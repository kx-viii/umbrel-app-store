// HTML for the share app: the public watch page, the expired page and the admin page.

const HLS_JS = "https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js";

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// JSON that's safe to put inside a <script> tag
const inline = (v) => JSON.stringify(v).replace(/</g, "\\u003c");

const BASE_CSS = `
:root { --bg:#f6f5f2; --panel:#fff; --text:#1d1c1a; --muted:#6b6862; --line:#e4e1db; --accent:#c2412d; --accent-text:#fff; }
@media (prefers-color-scheme: dark) { :root { --bg:#121212; --panel:#1c1c1c; --text:#efede9; --muted:#9c9890; --line:#2c2c2c; --accent:#e5533b; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
button, input, select { font:inherit; color:inherit; }
button { cursor:pointer; }
.muted { color:var(--muted); }
`;

function hoursLeft(expiresAt) {
  const h = Math.max(0, (expiresAt - Date.now()) / 3600_000);
  return h >= 2 ? `${Math.floor(h)} hours` : h >= 1 ? "1 hour" : `${Math.max(1, Math.round(h * 60))} minutes`;
}

function sizeText(bytes) {
  if (!bytes) return "";
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

function episodeLabel(e) {
  if (e.season == null || e.episode == null) return e.name;
  return `${e.episode}. ${e.name}`;
}

export function watchPage(share, publicUrl) {
  const base = `/s/${share.token}`;
  const single = share.items.length === 1;
  const page = {
    base,
    expiresAt: share.expiresAt,
    items: share.items.map((e) => ({ id: e.id, label: episodeLabel(e), subs: e.subs, size: sizeText(e.size), container: e.container })),
  };
  const ogImage = publicUrl ? `${publicUrl}${base}/poster` : "";
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<title>${esc(share.title)}</title>
<meta property="og:title" content="${esc(share.title)}">
<meta property="og:description" content="Ready to watch in your browser. Link works for another ${hoursLeft(share.expiresAt)}.">
${ogImage ? `<meta property="og:image" content="${esc(ogImage)}">` : ""}
<meta name="theme-color" content="#121212">
<style>${BASE_CSS}
.wrap { max-width:1100px; margin:0 auto; padding:24px 16px 48px; }
.head { display:flex; gap:20px; align-items:flex-end; margin-bottom:20px; }
.head img { width:96px; aspect-ratio:2/3; object-fit:cover; border-radius:8px; background:var(--line); flex:none; }
h1 { margin:0 0 4px; font-size:clamp(22px,4vw,32px); line-height:1.15; }
.player { position:relative; background:#000; border-radius:10px; overflow:hidden; aspect-ratio:16/9; }
video { width:100%; height:100%; display:block; background:#000; }
.start { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; background:#000 center/cover no-repeat; border:0; padding:0; }
.start::before { content:""; position:absolute; inset:0; background:rgba(0,0,0,.45); }
.start span { position:relative; display:flex; align-items:center; gap:10px; background:var(--accent); color:var(--accent-text); padding:14px 26px; border-radius:999px; font-weight:600; font-size:18px; }
.start span::before { content:""; border-style:solid; border-width:9px 0 9px 15px; border-color:transparent transparent transparent currentColor; }
.bar { display:flex; flex-wrap:wrap; gap:10px 18px; align-items:center; justify-content:space-between; margin:12px 2px 0; font-size:14px; }
.bar a { color:var(--muted); }
.note { margin-top:6px; font-size:13px; }
.eps { margin-top:24px; background:var(--panel); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
.eps h2 { margin:0; padding:14px 16px; font-size:16px; border-bottom:1px solid var(--line); }
.eps button { display:flex; width:100%; text-align:left; gap:10px; padding:12px 16px; border:0; border-bottom:1px solid var(--line); background:none; }
.eps button:last-child { border-bottom:0; }
.eps button:hover { background:var(--bg); }
.eps button[aria-current="true"] { font-weight:600; box-shadow:inset 3px 0 0 var(--accent); }
.eps .seen { margin-left:auto; color:var(--muted); font-size:13px; font-weight:400; }
.err { margin-top:12px; padding:12px 14px; border-radius:8px; background:var(--panel); border:1px solid var(--line); display:none; }
@media (max-width:560px) { .head img { width:72px; } .wrap { padding-top:16px; } }
</style>
</head><body>
<div class="wrap">
  <div class="head">
    <img src="${base}/poster" alt="">
    <div><h1>${esc(share.title)}</h1>
    <div class="muted">${share.year ? `${esc(share.year)} · ` : ""}Link works until <span id="until"></span></div></div>
  </div>
  <div class="player">
    <video id="v" controls playsinline crossorigin="anonymous" preload="none"></video>
    <button class="start" id="start" style="background-image:url('${base}/backdrop')"><span>Play</span></button>
  </div>
  <div class="bar"><span class="muted" id="now"></span><a id="dl" href="#" download>Download</a></div>
  <div class="note muted" id="dlnote"></div>
  <div class="err" id="err"></div>
  ${single ? "" : `<div class="eps"><h2>Episodes</h2><div id="eps"></div></div>`}
</div>
<script src="${HLS_JS}"></script>
<script>
const P = ${inline(page)};
const v = document.getElementById("v"), start = document.getElementById("start"), err = document.getElementById("err");
const session = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
let hls = null, current = 0, saveAt = 0;
document.getElementById("until").textContent = new Date(P.expiresAt).toLocaleString(undefined, { weekday:"short", day:"numeric", month:"short", hour:"numeric", minute:"2-digit" });

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, val) { try { localStorage.setItem(k, val); } catch {} },
};
const posKey = (i) => "share:" + P.base + ":" + P.items[i].id;

function showError(msg) { err.textContent = msg; err.style.display = "block"; }

function select(i, autoplay) {
  current = i;
  const it = P.items[i];
  document.getElementById("now").textContent = P.items.length > 1 ? it.label : "";
  const dl = document.getElementById("dl");
  dl.href = P.base + "/dl/" + it.id;
  dl.textContent = "Download" + (it.size ? " (" + it.size + ")" : "");
  document.getElementById("dlnote").textContent = it.container && !/mp4/.test(it.container)
    ? "The download is the original " + it.container.split(",")[0].toUpperCase() + " file. If it won't open, play it with VLC." : "";
  document.querySelectorAll("#eps button").forEach((b, n) => b.setAttribute("aria-current", n === i ? "true" : "false"));
  if (autoplay) play();
}

function play() {
  err.style.display = "none";
  start.style.display = "none";
  const it = P.items[current];
  const src = P.base + "/v/" + it.id + "/master.m3u8?ps=" + session + current;
  if (hls) { hls.destroy(); hls = null; }
  v.querySelectorAll("track").forEach((t) => t.remove());
  for (const s of it.subs) {
    const t = document.createElement("track");
    Object.assign(t, { kind: "subtitles", label: s.label, srclang: "en", src: P.base + "/sub/" + it.id + "/" + s.index + ".vtt" });
    v.appendChild(t);
  }
  const resume = Number(store.get(posKey(current))) || 0;
  const seek = () => { if (resume > 30 && (!v.duration || resume < v.duration - 60)) v.currentTime = resume; };
  if (window.Hls && Hls.isSupported()) {
    hls = new Hls({ maxBufferLength: 30 });
    hls.on(Hls.Events.ERROR, (_, d) => {
      if (!d.fatal) return;
      if (d.type === Hls.ErrorTypes.NETWORK_ERROR) showError("Having trouble loading the video. If this keeps happening, the link may have expired: refresh the page.");
      else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      else showError("This video couldn't be played here. Try the download instead.");
    });
    hls.loadSource(src);
    hls.attachMedia(v);
    hls.once(Hls.Events.MANIFEST_PARSED, () => { seek(); v.play().catch(() => {}); });
  } else if (v.canPlayType("application/vnd.apple.mpegurl")) {
    v.src = src;
    v.addEventListener("loadedmetadata", seek, { once: true });
    v.play().catch(() => {});
  } else {
    showError("This browser can't play the stream. Use the download link instead.");
  }
}

v.addEventListener("timeupdate", () => {
  if (Date.now() - saveAt < 5000) return;
  saveAt = Date.now();
  store.set(posKey(current), String(v.duration && v.currentTime > v.duration - 60 ? 0 : Math.floor(v.currentTime)));
});
v.addEventListener("ended", () => {
  store.set(posKey(current), "0");
  if (current + 1 < P.items.length) select(current + 1, true);
});
start.addEventListener("click", play);

const eps = document.getElementById("eps");
if (eps) {
  P.items.forEach((it, i) => {
    const b = document.createElement("button");
    b.textContent = it.label;
    const pos = Number(store.get(posKey(i))) || 0;
    if (pos > 30) { const s = document.createElement("span"); s.className = "seen"; s.textContent = "Resume " + Math.floor(pos / 60) + " min"; b.appendChild(s); }
    b.addEventListener("click", () => select(i, true));
    eps.appendChild(b);
  });
}
// Start where they left off: the first episode with saved progress, otherwise the first
const resumeAt = P.items.findIndex((_, i) => (Number(store.get(posKey(i))) || 0) > 30);
select(resumeAt >= 0 ? resumeAt : 0, false);
</script>
</body></html>`;
}

export function expiredPage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Link expired</title>
<style>${BASE_CSS} .box { max-width:420px; margin:18vh auto 0; padding:0 16px; text-align:center; } h1 { font-size:24px; margin:0 0 8px; }</style>
</head><body><div class="box"><h1>This link has expired</h1><p class="muted">Ask whoever sent it for a new one.</p></div></body></html>`;
}

export function adminPage(apiToken, publicUrl, defaultHours) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Share</title>
<style>${BASE_CSS}
.wrap { max-width:760px; margin:0 auto; padding:28px 16px 48px; }
h1 { margin:0 0 4px; font-size:26px; } h2 { font-size:17px; margin:28px 0 10px; }
.card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
.warn { border-color:var(--accent); margin-top:14px; }
.row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
input[type=search] { flex:1; min-width:200px; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:var(--bg); }
select { padding:9px 10px; border:1px solid var(--line); border-radius:8px; background:var(--bg); }
.btn { padding:9px 16px; border-radius:8px; border:1px solid var(--line); background:var(--bg); }
.btn.primary { background:var(--accent); border-color:var(--accent); color:var(--accent-text); font-weight:600; }
.list > div { display:flex; gap:12px; align-items:center; padding:10px 0; border-bottom:1px solid var(--line); }
.list > div:last-child { border-bottom:0; }
.list .grow { flex:1; min-width:0; }
.list .title { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.list .small { font-size:13px; }
.link { margin-top:12px; display:none; }
.link input { width:100%; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:var(--bg); }
.empty { padding:10px 0; }
</style></head><body>
<div class="wrap">
  <h1>Share</h1>
  <div class="muted">Make a link anyone can watch in their browser. Links stop working when they expire.</div>
  ${publicUrl ? "" : `<div class="card warn">PUBLIC_URL isn't set, so links won't work outside this network yet. Add it to the app's .env file and restart the app.</div>`}

  <h2>New link</h2>
  <div class="card">
    <div class="row">
      <input type="search" id="q" placeholder="Search films and shows" autocomplete="off">
      <select id="hours">${[6, 24, 48, 72, 168].map((h) => `<option value="${h}"${h === defaultHours ? " selected" : ""}>${h === 168 ? "1 week" : h + " hours"}</option>`).join("")}</select>
    </div>
    <div class="list" id="results"></div>
    <div class="link" id="link"><input readonly id="linkText"><div class="row" style="margin-top:8px"><button class="btn primary" id="copy">Copy link</button><span class="muted small" id="linkNote"></span></div></div>
  </div>

  <h2>Links</h2>
  <div class="card list" id="shares"></div>
</div>
<script>
const TOKEN = ${inline(apiToken)};
const api = async (path, opts = {}) => {
  const r = await fetch("api/" + path, { ...opts, headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || "Something went wrong (" + r.status + ")");
  return body;
};
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const results = document.getElementById("results");
const when = (t) => new Date(t).toLocaleString(undefined, { weekday:"short", day:"numeric", month:"short", hour:"numeric", minute:"2-digit" });

async function share(body) {
  try {
    const s = await api("shares", { method: "POST", body: JSON.stringify({ ...body, hours: Number(document.getElementById("hours").value), createdBy: "Umbrel" }) });
    document.getElementById("link").style.display = "block";
    document.getElementById("linkText").value = s.url;
    document.getElementById("linkNote").textContent = s.title + ", until " + when(s.expiresAt);
    loadShares();
  } catch (e) { alert(e.message); }
}

function row(title, sub, ...buttons) {
  return el("div", {}, el("div", { className: "grow" }, el("div", { className: "title", textContent: title }), el("div", { className: "muted small", textContent: sub })), ...buttons);
}
const button = (text, onclick, primary) => el("button", { className: "btn" + (primary ? " primary" : ""), textContent: text, onclick });

let timer;
document.getElementById("q").addEventListener("input", (e) => {
  clearTimeout(timer);
  const q = e.target.value.trim();
  if (q.length < 2) { results.replaceChildren(); return; }
  timer = setTimeout(async () => {
    const items = await api("search?q=" + encodeURIComponent(q)).catch(() => []);
    results.replaceChildren(...(items.length ? items.map((it) => it.type === "Series"
      ? row(it.name, (it.year || "") + " · Show", button("Seasons", () => seasons(it)))
      : row(it.name, (it.year || "") + " · Film", button("Share", () => share({ itemId: it.id }), true)))
      : [el("div", { className: "muted empty", textContent: "Nothing in the library matches." })]));
  }, 250);
});

async function seasons(show) {
  const list = await api("seasons/" + show.id).catch(() => []);
  results.replaceChildren(
    ...list.map((s) => row(show.name + ": " + s.name, s.episodes + " episode" + (s.episodes === 1 ? "" : "s") + " downloaded", button("Share", () => share({ itemId: s.id }), true))),
    row(show.name + ": every season", "All downloaded episodes", button("Share", () => share({ itemId: show.id }))),
  );
}

async function loadShares() {
  const list = await api("shares").catch(() => []);
  const box = document.getElementById("shares");
  if (!list.length) { box.replaceChildren(el("div", { className: "muted empty", textContent: "No links yet." })); return; }
  box.replaceChildren(...list.map((s) => {
    const live = s.status === "active";
    const info = (live ? "Until " + when(s.expiresAt) : s.status === "revoked" ? "Turned off" : "Expired " + when(s.expiresAt))
      + " · " + s.views + " view" + (s.views === 1 ? "" : "s") + (s.createdBy ? " · by " + s.createdBy : "");
    const r = row(s.title, info);
    if (live) r.append(
      button("Copy", () => navigator.clipboard.writeText(s.url)),
      button("Turn off", async () => { if (confirm("Turn off this link?")) { await api("shares/" + s.token, { method: "DELETE" }); loadShares(); } }),
    );
    return r;
  }));
}
document.getElementById("copy").addEventListener("click", () => navigator.clipboard.writeText(document.getElementById("linkText").value));
loadShares();
</script>
</body></html>`;
}

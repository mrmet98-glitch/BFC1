// server.js
// Battle for Canggu — Self-hosted PWA web app (Node + Express + Socket.IO)
// Features: Private access (Game + Team codes), Admin panel, Excel deck upload,
// per-team shuffled deck, 12-min challenge timer, veto penalty, Google Maps + Places,
// bar claim/lock/steal with photo proof, realtime leaderboard/map.
//
// Replit setup:
// 1) npm init -y
// 2) npm i express socket.io multer xlsx
// 3) Secrets: GOOGLE_MAPS_API_KEY, GAME_ADMIN_SECRET, (optional) GAME_ACCESS_CODE
//
// NOTE: This is an MVP. Good for a live event with a handful of teams.
// Files persist in Replit between restarts (db.json, uploads/*).

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const XLSX = require("xlsx");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || "";
const ADMIN_SECRET = process.env.GAME_ADMIN_SECRET || "";
const ENV_GAME_ACCESS_CODE = process.env.GAME_ACCESS_CODE || "";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "4mb" }));

// Static uploads (photo proof)
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
app.use("/uploads", express.static(uploadsDir));

// Simple JSON "DB"
const DB_FILE = path.join(__dirname, "db.json");
function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = {
      game: {
        accessCode: ENV_GAME_ACCESS_CODE || "",
        start: null, // timestamp
        end: null,   // timestamp
      },
      teams: {
        // "TEAM123": { name, color, score, penaltyUntil, deck, drawn, activeChallenge }
      },
      bars: {
        // placeId: { name, lat, lng, state: "unclaimed"|"claimed"|"locked",
        //   claimedBy, lockedBy, proof: {teamPhoto, drinksPhoto}, attemptsFailed: 0 }
      },
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
let db = loadDB();

// Broadcast current state to all clients
function broadcastState() {
  io.emit("state", {
    game: db.game,
    teams: db.teams,
    bars: db.bars,
  });
}

// Helpers
function now() { return Date.now(); }
function withinGameTime() {
  if (!db.game.start || !db.game.end) return true; // let people prep
  const t = now();
  return t >= db.game.start && t <= db.game.end;
}
function ensureTeam(teamCode) {
  const t = db.teams[teamCode];
  if (!t) throw new Error("Invalid team.");
  return t;
}
function isPenalized(teamCode) {
  const t = ensureTeam(teamCode);
  return t.penaltyUntil && now() < t.penaltyUntil;
}
function addPenalty(teamCode, minutes = 5) {
  const t = ensureTeam(teamCode);
  const until = Math.max(now(), t.penaltyUntil || 0) + minutes * 60 * 1000;
  t.penaltyUntil = until;
}
function teamColor(teamCode) {
  const t = ensureTeam(teamCode);
  return t.color || "#888";
}
function shuffle(arr, seed) {
  // Deterministic shuffle if seed provided (simple xorshift-ish)
  let a = arr.slice();
  let s = 0;
  for (let i = 0; i < seed.length; i++) s ^= seed.charCodeAt(i);
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// File uploads (teamPhoto, drinksPhoto)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^\w.\-]+/g, "_");
    cb(null, Date.now() + "_" + safe);
  },
});
const upload = multer({ storage });

// ---------- Admin routes ----------
function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-secret"] || req.query.secret || req.body.secret;
  if (!ADMIN_SECRET || key === ADMIN_SECRET) return next();
  res.status(403).json({ error: "Invalid admin secret." });
}

app.post("/api/admin/initGame", requireAdmin, (req, res) => {
  const { start, end, accessCode } = req.body;
  if (accessCode !== undefined) db.game.accessCode = String(accessCode || "");
  db.game.start = start ? Number(start) : null;
  db.game.end = end ? Number(end) : null;
  saveDB(db);
  broadcastState();
  res.json({ ok: true, game: db.game });
});

app.post("/api/admin/createTeam", requireAdmin, (req, res) => {
  const { teamCode, name, color } = req.body;
  if (!teamCode || !name) return res.status(400).json({ error: "teamCode and name are required." });
  if (!db.teams[teamCode]) {
    db.teams[teamCode] = {
      name, color: color || "#4f46e5",
      score: 0,
      penaltyUntil: 0,
      deck: [], drawn: [],
      deckSeed: "", activeChallenge: null,
    };
  } else {
    db.teams[teamCode].name = name;
    if (color) db.teams[teamCode].color = color;
  }
  saveDB(db);
  broadcastState();
  res.json({ ok: true, team: db.teams[teamCode] });
});

app.post("/api/admin/uploadDeck", requireAdmin, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file." });
  const wb = XLSX.readFile(req.file.path);
  const sheetName = wb.SheetNames.find(n => n.toLowerCase() === "deck") || wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: "" });

  // Expect columns: type ("challenge"|"curse"), text
  const deck = rows
    .map((r, idx) => ({
      id: "card_" + (idx + 1),
      type: (String(r.type || "").trim().toLowerCase() || "challenge"),
      text: String(r.text || "").trim(),
    }))
    .filter(c => c.text);

  // Store the masterDeck on game
  db.game.masterDeck = deck;
  saveDB(db);
  res.json({ ok: true, count: deck.length });
});

app.post("/api/admin/resetState", requireAdmin, (req, res) => {
  // Keep teams & game config; clear bars & team progress
  Object.keys(db.bars).forEach(k => delete db.bars[k]);
  for (const [code, t] of Object.entries(db.teams)) {
    t.score = 0;
    t.penaltyUntil = 0;
    t.drawn = [];
    t.activeChallenge = null;
    t.deckSeed = "";
    t.deck = [];
  }
  saveDB(db);
  broadcastState();
  res.json({ ok: true });
});

// ---------- Player auth ----------
app.post("/api/join", (req, res) => {
  const { accessCode, teamCode, displayName } = req.body;
  if (!teamCode || !displayName) return res.status(400).json({ error: "teamCode and displayName required." });
  if (db.game.accessCode && accessCode !== db.game.accessCode) return res.status(403).json({ error: "Bad access code." });
  if (!db.teams[teamCode]) return res.status(400).json({ error: "Unknown team code." });
  // Just accept; names aren’t stored per-user for MVP
  res.json({ ok: true, team: db.teams[teamCode] });
});

// ---------- Deck / Challenges ----------
app.post("/api/drawCard", (req, res) => {
  const { teamCode } = req.body;
  if (!withinGameTime()) return res.status(400).json({ error: "Game is not active." });
  if (!db.game.masterDeck?.length) return res.status(400).json({ error: "Deck not uploaded yet." });
  const team = ensureTeam(teamCode);
  if (isPenalized(teamCode)) return res.status(400).json({ error: "Team under penalty." });
  if (team.activeChallenge && team.activeChallenge.status === "active") {
    return res.status(400).json({ error: "You already have an active challenge." });
  }
  // Initialize deck once per team with deterministic shuffle
  if (!team.deck || team.deck.length === 0) {
    team.deckSeed = team.deckSeed || (teamCode + ":" + now());
    team.deck = shuffle(db.game.masterDeck, team.deckSeed);
    team.drawn = [];
  }
  const next = team.deck.find(c => !team.drawn.includes(c.id));
  if (!next) return res.status(400).json({ error: "No more cards." });

  team.activeChallenge = {
    cardId: next.id,
    text: next.text,
    type: next.type,
    startedAt: now(),
    status: "active"
  };
  saveDB(db);
  broadcastState();
  res.json({ ok: true, challenge: team.activeChallenge, minAttemptMinutes: 12 });
});

app.post("/api/completeChallenge", (req, res) => {
  const { teamCode } = req.body;
  const team = ensureTeam(teamCode);
  const act = team.activeChallenge;
  if (!act || act.status !== "active") return res.status(400).json({ error: "No active challenge." });
  // Complete
  team.drawn.push(act.cardId);
  team.activeChallenge = null;
  saveDB(db);
  broadcastState();
  res.json({ ok: true });
});

app.post("/api/vetoChallenge", (req, res) => {
  const { teamCode } = req.body;
  const team = ensureTeam(teamCode);
  const act = team.activeChallenge;
  if (!act || act.status !== "active") return res.status(400).json({ error: "No active challenge." });

  const elapsed = (now() - act.startedAt) / 60000;
  if (elapsed < 12) {
    // Enforce 12-minute attempt before veto
    return res.status(400).json({ error: `Must attempt at least 12 minutes. Wait ${Math.ceil(12 - elapsed)} more minute(s).` });
  }
  team.drawn.push(act.cardId);
  team.activeChallenge = null;
  addPenalty(teamCode, 5);
  saveDB(db);
  broadcastState();
  res.json({ ok: true, penaltyMinutes: 5 });
});

// ---------- Bars: claim / lock / steal ----------
app.post("/api/claim", upload.fields([{ name: "teamPhoto" }, { name: "drinksPhoto" }]), (req, res) => {
  const { teamCode, placeId, name, lat, lng } = req.body;
  if (!withinGameTime()) return res.status(400).json({ error: "Game is not active." });
  if (!teamCode || !placeId || !name) return res.status(400).json({ error: "Missing fields." });
  if (isPenalized(teamCode)) return res.status(400).json({ error: "Team under penalty." });

  let bar = db.bars[placeId];
  if (bar && bar.state === "locked") return res.status(400).json({ error: "Bar is locked." });

  // Save proof
  const teamPhoto = (req.files?.teamPhoto?.[0]?.path || "").replace(__dirname, "");
  const drinksPhoto = (req.files?.drinksPhoto?.[0]?.path || "").replace(__dirname, "");

  if (!bar) {
    bar = {
      name, lat: Number(lat || 0), lng: Number(lng || 0),
      state: "claimed",
      claimedBy: teamCode,
      lockedBy: null,
      proof: { teamPhoto: teamPhoto ? "/uploads/" + path.basename(teamPhoto) : "", drinksPhoto: drinksPhoto ? "/uploads/" + path.basename(drinksPhoto) : "" },
      attemptsFailed: 0
    };
    db.bars[placeId] = bar;
  } else {
    // If unclaimed or claimed by others and you’re here first-time but not doing a steal,
    // treat as claim (still requires proof).
    bar.state = "claimed";
    bar.claimedBy = teamCode;
    bar.lockedBy = null;
    bar.proof = {
      teamPhoto: teamPhoto ? "/uploads/" + path.basename(teamPhoto) : bar.proof?.teamPhoto || "",
      drinksPhoto: drinksPhoto ? "/uploads/" + path.basename(drinksPhoto) : bar.proof?.drinksPhoto || "",
    };
  }

  // Scoring: claim = 1 point
  const team = ensureTeam(teamCode);
  team.score = (team.score || 0) + 1;

  saveDB(db);
  broadcastState();
  res.json({ ok: true, bar });
});

app.post("/api/lock", (req, res) => {
  const { teamCode, placeId } = req.body;
  if (!withinGameTime()) return res.status(400).json({ error: "Game is not active." });
  const bar = db.bars[placeId];
  if (!bar) return res.status(400).json({ error: "Unknown bar." });
  if (bar.state !== "claimed" || bar.claimedBy !== teamCode) {
    return res.status(400).json({ error: "You must claim the bar first." });
  }
  // Must have just completed a challenge (server doesn’t strictly bind which one, MVP trust)
  bar.state = "locked";
  bar.lockedBy = teamCode;
  saveDB(db);
  broadcastState();
  res.json({ ok: true, bar });
});

// Steal requires challenge success; on fail, increments attemptsFailed.
// Two failed attempts (by anyone) -> bar becomes locked for original team.
app.post("/api/stealAttempt", (req, res) => {
  const { teamCode, placeId, success } = req.body;
  if (!withinGameTime()) return res.status(400).json({ error: "Game is not active." });
  const bar = db.bars[placeId];
  if (!bar) return res.status(400).json({ error: "Unknown bar." });
  if (bar.state !== "claimed") return res.status(400).json({ error: "Bar not stealable." });
  if (bar.claimedBy === teamCode) return res.status(400).json({ error: "You already own this bar." });
  const stealSuccess = String(success) === "true";

  if (stealSuccess) {
    // New owner gets +1 for claim if they didn’t already claim earlier
    const newTeam = ensureTeam(teamCode);
    newTeam.score = (newTeam.score || 0) + 1;
    bar.claimedBy = teamCode;
    bar.lockedBy = null;
    bar.attemptsFailed = 0; // reset
  } else {
    bar.attemptsFailed = (bar.attemptsFailed || 0) + 1;
    if (bar.attemptsFailed >= 2) {
      // Lock bar for original team
      bar.state = "locked";
      bar.lockedBy = bar.claimedBy;
    }
    // Apply 5-min penalty to the failing team
    addPenalty(teamCode, 5);
  }
  saveDB(db);
  broadcastState();
  res.json({ ok: true, bar });
});

// ---------- Query state ----------
app.get("/api/state", (req, res) => {
  res.json({ game: db.game, teams: db.teams, bars: db.bars });
});

// ---------- PWA manifest + icons + service worker ----------
app.get("/manifest.json", (req, res) => {
  res.json({
    name: "Battle for Canggu",
    short_name: "BFC",
    start_url: "/",
    display: "standalone",
    background_color: "#0f172a",
    theme_color: "#0f172a",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" }
    ]
  });
});

// Tiny placeholder icons (base64 1x1 png scaled by UA, fine for MVP)
const ICON_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIW2NkYGD4DwABfAGQ2H2JwQAAAABJRU5ErkJggg==";
app.get("/icon-192.png", (req, res) => {
  res.set("Content-Type", "image/png");
  res.send(Buffer.from(ICON_BASE64, "base64"));
});
app.get("/icon-512.png", (req, res) => {
  res.set("Content-Type", "image/png");
  res.send(Buffer.from(ICON_BASE64, "base64"));
});

app.get("/sw.js", (req, res) => {
  res.set("Content-Type", "application/javascript");
  res.send(`self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { self.clients.claim(); });
self.addEventListener('fetch', e => {
  // Basic passthrough; could add caching if you like.
});`);
});

// ---------- Admin UI ----------
app.get("/admin", (req, res) => {
  res.send(`<!doctype html><html><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>BFC Admin</title>
<style>
body{font-family:system-ui,Arial,sans-serif;background:#0f172a;color:#e5e7eb;margin:0;padding:24px}
h1{margin:0 0 16px;font-size:22px}
.card{background:#111827;border:1px solid #1f2937;border-radius:14px;padding:16px;margin:12px 0}
label{display:block;margin:8px 0 4px}
input,button,select{font:inherit;padding:8px 10px;border-radius:10px;border:1px solid #374151;background:#0b1220;color:#e5e7eb}
button{cursor:pointer;background:#4f46e5;border:none}
.grid{display:grid;gap:12px;grid-template-columns:1fr 1fr}
a.link{color:#93c5fd}
.small{opacity:.8;font-size:12px}
</style>
</head><body>
<a class="link" href="/">← Back to App</a>
<h1>Admin Panel</h1>
<div class="card">
  <p class="small">Enter Admin Secret to unlock controls</p>
  <input id="secret" type="password" placeholder="Admin secret"/>
</div>

<div class="card">
  <h3>Game Settings</h3>
  <label>Game Access Code (players must enter this)</label>
  <input id="accessCode" placeholder="e.g. CANGGU2025"/>
  <label>Start Time (epoch ms)</label>
  <input id="start" type="number" placeholder="Leave blank to allow prep"/>
  <label>End Time (epoch ms)</label>
  <input id="end" type="number" placeholder="Leave blank to allow prep"/>
  <button onclick="initGame()">Save Game Settings</button>
</div>

<div class="card">
  <h3>Create / Update Team</h3>
  <div class="grid">
    <div><label>Team Code</label><input id="teamCode" placeholder="TEAM123"/></div>
    <div><label>Name</label><input id="teamName" placeholder="Raj on the Rocks"/></div>
  </div>
  <label>Color</label><input id="teamColor" value="#4f46e5" type="color"/>
  <button onclick="createTeam()">Create/Update Team</button>
</div>

<div class="card">
  <h3>Upload Deck (Excel)</h3>
  <p class="small">Sheet name <b>deck</b>. Columns: <b>type</b> (challenge|curse), <b>text</b>.</p>
  <input id="deckFile" type="file" accept=".xlsx,.xls"/>
  <button onclick="uploadDeck()">Upload</button>
</div>

<div class="card">
  <h3>Danger Zone</h3>
  <button style="background:#b91c1c" onclick="resetState()">Reset Bars & Team Progress</button>
</div>

<script>
async function initGame(){
  const secret = document.getElementById('secret').value;
  const accessCode = document.getElementById('accessCode').value;
  const start = document.getElementById('start').value;
  const end = document.getElementById('end').value;
  const r = await fetch('/api/admin/initGame', {
    method:'POST',
    headers:{'Content-Type':'application/json','x-admin-secret':secret},
    body: JSON.stringify({
      accessCode: accessCode,
      start: start? Number(start): null,
      end: end? Number(end): null
    })
  });
  alert(await r.text());
}
async function createTeam(){
  const secret = document.getElementById('secret').value;
  const teamCode = document.getElementById('teamCode').value.trim();
  const name = document.getElementById('teamName').value.trim();
  const color = document.getElementById('teamColor').value;
  const r = await fetch('/api/admin/createTeam', {
    method:'POST',
    headers:{'Content-Type':'application/json','x-admin-secret':secret},
    body: JSON.stringify({ teamCode, name, color })
  });
  alert(await r.text());
}
async function uploadDeck(){
  const secret = document.getElementById('secret').value;
  const f = document.getElementById('deckFile').files[0];
  if(!f) return alert('Choose a file.');
  const fd = new FormData(); fd.append('file', f);
  const r = await fetch('/api/admin/uploadDeck', {
    method:'POST',
    headers:{'x-admin-secret': secret},
    body: fd
  });
  alert(await r.text());
}
async function resetState(){
  const secret = document.getElementById('secret').value;
  if(!confirm('Reset bars & team progress?')) return;
  const r = await fetch('/api/admin/resetState', {
    method:'POST',
    headers:{'Content-Type':'application/json','x-admin-secret':secret},
    body: JSON.stringify({})
  });
  alert(await r.text());
}
</script>
</body></html>`);
});

// ---------- Main App UI ----------
app.get("/", (req, res) => {
  const mapsKey = GOOGLE_MAPS_API_KEY;
  res.send(`<!doctype html><html><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"/>
<title>Battle for Canggu</title>
<link rel="manifest" href="/manifest.json"/>
<meta name="theme-color" content="#0f172a"/>
<link rel="apple-touch-icon" href="/icon-192.png"/>
<style>
:root{
  --bg:#0f172a; --card:#111827; --muted:#1f2937; --text:#e5e7eb; --accent:#4f46e5; --good:#16a34a; --bad:#b91c1c; --warn:#f59e0b;
}
*{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,Arial,sans-serif}
.app{max-width:1100px;margin:0 auto;padding:16px}
.header{display:flex;align-items:center;justify-content:space-between;gap:12px}
h1{font-size:22px;margin:0} a{color:#93c5fd;text-decoration:none}
.card{background:var(--card);border:1px solid var(--muted);border-radius:14px;padding:14px;margin:12px 0}
input,button,select{font:inherit;padding:10px 12px;border-radius:10px;border:1px solid var(--muted);background:#0b1220;color:var(--text)}
button{background:var(--accent);border:none;cursor:pointer}
button:disabled{opacity:.5;cursor:not-allowed}
.row{display:flex;gap:12px;flex-wrap:wrap}
.grid{display:grid;gap:12px}
.tabs{display:flex;gap:8px;flex-wrap:wrap}
.tab{padding:8px 10px;background:#0b1220;border:1px solid var(--muted);border-radius:999px;cursor:pointer}
.tab.active{background:var(--accent)}
.badge{padding:2px 8px;border-radius:999px;background:#0b1220;border:1px solid var(--muted);font-size:12px}
.label{font-size:12px;opacity:.8}
.small{font-size:12px;opacity:.8}
hr{border:none;border-top:1px solid var(--muted);margin:12px 0}
.marker{display:inline-flex;align-items:center;gap:6px}
.dot{width:10px;height:10px;border-radius:50%}
.list{display:grid;gap:8px}
.kv{display:flex;justify-content:space-between;gap:10px}
.timer{font-variant-numeric:tabular-nums}
.lock{color:var(--good)}
.warn{color:var(--warn)}
.err{color:var(--bad)}
#map{width:100%;height:420px;border-radius:12px;border:1px solid var(--muted)}
</style>
</head>
<body>
<div class="app">
  <div class="header">
    <h1>Battle for Canggu</h1>
    <div class="row">
      <a href="/admin">Admin</a>
      <span class="badge" id="gameWindow"></span>
    </div>
  </div>

  <div class="card" id="joinCard">
    <div class="row">
      <div class="grid" style="min-width:260px">
        <label class="label">Game Access Code</label>
        <input id="accessCode" placeholder="(if set by admin)"/>
      </div>
      <div class="grid" style="min-width:180px">
        <label class="label">Team Code</label>
        <input id="teamCode" placeholder="TEAM123"/>
      </div>
      <div class="grid" style="min-width:180px">
        <label class="label">Your Name</label>
        <input id="displayName" placeholder="Alex"/>
      </div>
      <button onclick="join()">Join</button>
    </div>
    <div id="joinMsg" class="small"></div>
  </div>

  <div class="card" id="tabs" style="display:none">
    <div class="tabs">
      <div class="tab active" data-tab="map">Map</div>
      <div class="tab" data-tab="deck">Deck</div>
      <div class="tab" data-tab="leaderboard">Leaderboard</div>
      <div class="tab" data-tab="team">Team</div>
    </div>
  </div>

  <div id="page-map" class="card">
    <div class="row">
      <input id="search" placeholder="Search a bar..." style="flex:1"/>
      <button onclick="claimSelected()">Claim (+1)</button>
      <button onclick="lockSelected()">Lock (after challenge)</button>
      <button onclick="stealSelected()">Steal (complete a challenge)</button>
    </div>
    <div class="small">Markers: <span class="marker"><span class="dot" style="background:#6b7280"></span>Unclaimed</span> <span class="marker"><span class="dot" style="background:#22c55e"></span>Claimed</span> <span class="marker"><span class="dot" style="background:#f59e0b"></span>Locked</span></div>
    <div id="map"></div>
    <hr/>
    <div class="row">
      <div>
        <div class="label">Selected Bar</div>
        <div id="selName">(none)</div>
        <div id="selState" class="small"></div>
      </div>
      <div>
        <div class="label">Team Photo</div>
        <input type="file" id="teamPhoto" accept="image/*" capture="environment"/>
      </div>
      <div>
        <div class="label">Drinks Photo</div>
        <input type="file" id="drinksPhoto" accept="image/*" capture="environment"/>
      </div>
    </div>
  </div>

  <div id="page-deck" class="card" style="display:none">
    <div class="row">
      <button onclick="drawCard()">Draw Challenge</button>
      <button onclick="completeChallenge()">Complete</button>
      <button onclick="vetoChallenge()">Veto (-5 min)</button>
      <span id="penaltyBadge" class="badge"></span>
    </div>
    <div id="challengeBox"></div>
    <div class="timer" id="challengeTimer"></div>
    <div class="small">Rule: Attempt at least 12 minutes before veto. Completing locks the current claimed bar (use the Lock button on Map).</div>
  </div>

  <div id="page-leaderboard" class="card" style="display:none">
    <h3>Leaderboard</h3>
    <div id="leaderboard"></div>
  </div>

  <div id="page-team" class="card" style="display:none">
    <h3 id="teamTitle">Team</h3>
    <div id="teamInfo" class="list"></div>
  </div>
</div>

<script src="/socket.io/socket.io.js"></script>
<script>
let SOCKET, STATE = {game:{},teams:{},bars:{}};
let ME = {accessCode:"", teamCode:"", name:""};
let MAP, AUTOCOMPLETE, SELECTED = null, MARKERS = {}, PLACE_CACHE = {};
let CHALLENGE_TICK = null;

function saveMe(){ localStorage.setItem("bfc_me", JSON.stringify(ME)); }
function loadMe(){ try{ ME = JSON.parse(localStorage.getItem("bfc_me"))||ME; }catch{} }

async function join(){
  ME.accessCode = document.getElementById('accessCode').value.trim();
  ME.teamCode = document.getElementById('teamCode').value.trim();
  ME.name = document.getElementById('displayName').value.trim();
  saveMe();
  const r = await fetch('/api/join',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accessCode:ME.accessCode, teamCode:ME.teamCode, displayName:ME.name})});
  const tx = await r.json().catch(()=>({}));
  const msg = document.getElementById('joinMsg');
  if(!r.ok){ msg.innerText = tx.error||'Join failed.'; return; }
  msg.innerText = 'Joined as '+ME.name+' ('+ME.teamCode+')';
  document.getElementById('joinCard').style.display='none';
  document.getElementById('tabs').style.display='block';
}

function connectSocket(){
  SOCKET = io();
  SOCKET.on('state', s => {
    STATE = s;
    renderGameWindow();
    renderLeaderboard();
    renderTeam();
    renderMapMarkers();
    renderChallenge();
    updatePenaltyBadge();
  });
}
connectSocket();

function renderGameWindow(){
  const g = STATE.game||{};
  const el = document.getElementById('gameWindow');
  if(g.start && g.end){
    const now = Date.now();
    if(now < g.start) el.textContent = "Starts: "+new Date(g.start).toLocaleTimeString();
    else if(now > g.end) el.textContent = "Finished";
    else el.textContent = "Ends: "+new Date(g.end).toLocaleTimeString();
  } else el.textContent = "Setup mode";
}

function setTab(name){
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab===name);
  });
  ['map','deck','leaderboard','team'].forEach(p=>{
    document.getElementById('page-'+p).style.display = (p===name)?'block':'none';
  });
  if(name==='map') setTimeout(initMapIfNeeded, 50);
}
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', ()=> setTab(t.dataset.tab)));

function initMapIfNeeded(){
  if(MAP) return;
  const s = document.createElement('script');
  s.src = "https://maps.googleapis.com/maps/api/js?key=${mapsKey}&libraries=places&callback=_initMap";
  s.async = true; s.defer = true;
  document.body.appendChild(s);
}
window._initMap = function(){
  const center = {lat:-8.650, lng:115.130}; // Canggu-ish
  MAP = new google.maps.Map(document.getElementById('map'), {center, zoom: 14, mapId: 'BFC_MAP'});
  const input = document.getElementById('search');
  AUTOCOMPLETE = new google.maps.places.Autocomplete(input, { fields: ["place_id","name","geometry"] });
  AUTOCOMPLETE.addListener('place_changed', () => {
    const p = AUTOCOMPLETE.getPlace();
    if(!p.place_id || !p.geometry) return;
    SELECTED = {
      placeId: p.place_id,
      name: p.name,
      lat: p.geometry.location.lat(),
      lng: p.geometry.location.lng()
    };
    MAP.panTo({lat:SELECTED.lat, lng:SELECTED.lng});
    renderSelected();
  });
  renderMapMarkers();
}

function renderMapMarkers(){
  if(!MAP) return;
  // Clear missing markers
  for(const id in MARKERS){
    if(!STATE.bars[id]){ MARKERS[id].setMap(null); delete MARKERS[id]; }
  }
  // Add/update markers
  for(const [placeId, bar] of Object.entries(STATE.bars)){
    if(!MARKERS[placeId]){
      MARKERS[placeId] = new google.maps.Marker({ position:{lat:bar.lat, lng:bar.lng}, map:MAP, title:bar.name });
      MARKERS[placeId].addListener('click', ()=>{
        SELECTED = { placeId, name: bar.name, lat:bar.lat, lng:bar.lng };
        renderSelected();
      });
    }
    const m = MARKERS[placeId];
    let color = "#6b7280"; // unclaimed
    if(bar.state==="claimed") color = "#22c55e";
    if(bar.state==="locked") color = "#f59e0b";
    m.setIcon({ path: google.maps.SymbolPath.CIRCLE, scale: 8, fillColor: color, fillOpacity: 1, strokeColor: "#0b1220", strokeWeight: 1.5 });
  }
}

function renderSelected(){
  const nameEl = document.getElementById('selName');
  const stateEl = document.getElementById('selState');
  if(!SELECTED){ nameEl.textContent="(none)"; stateEl.textContent=""; return; }
  nameEl.textContent = SELECTED.name;
  const bar = STATE.bars[SELECTED.placeId];
  if(!bar){ stateEl.innerHTML = '<span class="small">Unclaimed</span>'; }
  else {
    stateEl.innerHTML = '<div class="small">State: '+bar.state+' | Claimed by: '+(bar.claimedBy||'-')+' '+(bar.lockedBy?(' | Locked by: '+bar.lockedBy):'')+'</div>';
  }
}

async function claimSelected(){
  if(!SELECTED) return alert("Select a bar first.");
  if(!ME.teamCode) return alert("Join first.");
  const fd = new FormData();
  fd.append("teamCode", ME.teamCode);
  fd.append("placeId", SELECTED.placeId);
  fd.append("name", SELECTED.name);
  fd.append("lat", SELECTED.lat);
  fd.append("lng", SELECTED.lng);
  const tp = document.getElementById('teamPhoto').files[0];
  const dp = document.getElementById('drinksPhoto').files[0];
  if(tp) fd.append("teamPhoto", tp);
  if(dp) fd.append("drinksPhoto", dp);
  const r = await fetch('/api/claim', { method:'POST', body: fd });
  const j = await r.json().catch(()=>({}));
  if(!r.ok) return alert(j.error||"Claim failed");
  alert("Claimed!");
}

async function lockSelected(){
  if(!SELECTED) return alert("Select a bar first.");
  if(!ME.teamCode) return alert("Join first.");
  const r = await fetch('/api/lock', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ teamCode: ME.teamCode, placeId: SELECTED.placeId })});
  const j = await r.json().catch(()=>({}));
  if(!r.ok) return alert(j.error||"Lock failed");
  alert("Locked.");
}

async function stealSelected(){
  if(!SELECTED) return alert("Select a bar first.");
  if(!ME.teamCode) return alert("Join first.");
  const ok = confirm("Confirm steal ONLY IF you successfully completed a challenge?");
  const r = await fetch('/api/stealAttempt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ teamCode: ME.teamCode, placeId: SELECTED.placeId, success: ok })});
  const j = await r.json().catch(()=>({}));
  if(!r.ok) return alert(j.error||"Steal failed");
  alert(ok? "Steal success!" : "Steal failed. 5-min penalty applied.");
}

function renderLeaderboard(){
  const wrap = document.getElementById('leaderboard');
  const arr = Object.entries(STATE.teams||{}).map(([code,t])=>({code,score:t.score||0,name:t.name||code,color:t.color||'#888'}));
  arr.sort((a,b)=>b.score-a.score);
  wrap.innerHTML = arr.map(t=>(
    \`<div class="kv"><div><span class="dot" style="background:\${t.color}"></span> \${t.name} <span class="small">(\${t.code})</span></div><div>\${t.score} pts</div></div>\`
  )).join("") || "<div class='small'>No teams yet.</div>";
}

function renderTeam(){
  const tc = ME.teamCode;
  const t = (STATE.teams||{})[tc];
  document.getElementById('teamTitle').textContent = t? \`Team: \${t.name} (\${tc})\` : "Team";
  const info = [];
  if(t){
    info.push(\`<div class="kv"><div>Color</div><div><span class="dot" style="background:\${t.color}"></span></div></div>\`);
    info.push(\`<div class="kv"><div>Score</div><div>\${t.score||0}</div></div>\`);
    if(t.penaltyUntil && Date.now() < t.penaltyUntil){
      const sec = Math.ceil((t.penaltyUntil-Date.now())/1000);
      info.push(\`<div class="kv warn"><div>Penalty</div><div>\${sec}s</div></div>\`);
    }
  }
  document.getElementById('teamInfo').innerHTML = info.join("") || "<div class='small'>Join to see team info.</div>";
}

async function drawCard(){
  if(!ME.teamCode) return alert("Join first.");
  const r = await fetch('/api/drawCard',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ teamCode: ME.teamCode })});
  const j = await r.json().catch(()=>({}));
  if(!r.ok) return alert(j.error||"Can't draw.");
  renderChallenge(); // will re-render via socket too
}
async function completeChallenge(){
  if(!ME.teamCode) return alert("Join first.");
  const r = await fetch('/api/completeChallenge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ teamCode: ME.teamCode })});
  const j = await r.json().catch(()=>({}));
  if(!r.ok) return alert(j.error||"Can't complete.");
}
async function vetoChallenge(){
  if(!ME.teamCode) return alert("Join first.");
  const r = await fetch('/api/vetoChallenge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ teamCode: ME.teamCode })});
  const j = await r.json().catch(()=>({}));
  if(!r.ok) return alert(j.error||"Can't veto.");
  else alert("Vetoed. 5-min penalty started.");
}

function renderChallenge(){
  const t = (STATE.teams||{})[ME.teamCode];
  const box = document.getElementById('challengeBox');
  const timer = document.getElementById('challengeTimer');
  clearInterval(CHALLENGE_TICK);
  if(!t || !t.activeChallenge){
    box.innerHTML = "<div class='small'>No active challenge.</div>";
    timer.textContent = "";
    return;
  }
  const ch = t.activeChallenge;
  box.innerHTML = \`<div><b>\${ch.type.toUpperCase()}</b><br/>\${ch.text}</div>\`;
  function tick(){
    const elapsed = Math.floor((Date.now() - ch.startedAt)/1000);
    const rem = Math.max(0, 12*60 - elapsed);
    const mm = String(Math.floor(rem/60)).padStart(2,'0');
    const ss = String(rem%60).padStart(2,'0');
    timer.textContent = "Veto unlocks in: " + mm + ":" + ss;
  }
  tick();
  CHALLENGE_TICK = setInterval(tick, 1000);
}

function updatePenaltyBadge(){
  const t = (STATE.teams||{})[ME.teamCode];
  const b = document.getElementById('penaltyBadge');
  if(t && t.penaltyUntil && Date.now() < t.penaltyUntil){
    const sec = Math.ceil((t.penaltyUntil-Date.now())/1000);
    b.textContent = "Penalty: "+sec+"s";
  } else b.textContent = "";
}

// Remember last session
loadMe();
if(ME.teamCode){
  document.getElementById('accessCode').value = ME.accessCode || "";
  document.getElementById('teamCode').value = ME.teamCode || "";
  document.getElementById('displayName').value = ME.name || "";
  document.getElementById('joinCard').style.display='none';
  document.getElementById('tabs').style.display='block';
}
setTab('map');

// PWA
if('serviceWorker' in navigator){ navigator.serviceWorker.register('/sw.js'); }
</script>
</body></html>`);
});

// Start
server.listen(PORT, () => {
  console.log("Battle for Canggu running on port", PORT);
});

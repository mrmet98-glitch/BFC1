// server.js
// Battle for Canggu — Multi-game codes + Admin panel + Mobile-friendly UI
// - Game codes: Testing123, TestingFri, TestBOM, TestDPS, rajuiskadak
// - Claim needs photo; Steal/Lock don't
// - Scores = owned bars + admin adjustments
// - Admin panel (/admin, password: raju123): edit bars/owners/lock, adjust scores, reset game

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || "";

// -------- Teams (fixed) --------
const TEAMS = [
  { code: "NAP123",  name: "Raj's Nap Champs",        color: "#ef4444" },
  { code: "PUMP456", name: "Raj's Pumpers & Dumpers", color: "#f59e0b" },
  { code: "ROCK789", name: "Raj on the Rocks",        color: "#22c55e" },
  { code: "RAJMA777",name: "Big Rajma",               color: "#3b82f6" },
];

// -------- Allowed game codes --------
const GAME_CODES = ["Testing123", "TestingFri", "TestBOM", "TestDPS", "rajuiskadak"];

// -------- Admin password --------
const ADMIN_PASSWORD = "raju123";

// -------- App, IO, uploads --------
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));

const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
app.use("/uploads", express.static(uploadsDir));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const safe = (file.originalname || "photo").replace(/[^\w.\-]+/g, "_");
    cb(null, Date.now() + "_" + safe);
  },
});
const upload = multer({ storage });

// -------- DB: one file, multiple games --------
const DB_FILE = path.join(__dirname, "db.json");
function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = { teams: TEAMS, games: {} };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
  }
  const json = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  if (!json.games) json.games = {};
  for (const code of GAME_CODES) {
    if (!json.games[code]) json.games[code] = { bars: {}, adjustments: {} };
  }
  for (const code of GAME_CODES) {
    const g = json.games[code];
    if (!g.adjustments) g.adjustments = {};
    for (const t of TEAMS) if (g.adjustments[t.code] === undefined) g.adjustments[t.code] = 0;
  }
  json.teams = TEAMS;
  fs.writeFileSync(DB_FILE, JSON.stringify(json, null, 2));
  return json;
}
function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
let db = loadDB();

// -------- Helpers --------
function validGame(code) { return GAME_CODES.includes(code); }
function ensureGame(gameCode) {
  if (!validGame(gameCode)) throw new Error("Invalid game code");
  if (!db.games[gameCode]) db.games[gameCode] = { bars: {}, adjustments: {} };
  for (const t of TEAMS) {
    if (db.games[gameCode].adjustments[t.code] === undefined) {
      db.games[gameCode].adjustments[t.code] = 0;
    }
  }
  return db.games[gameCode];
}
function computeScores(game) {
  const counts = {};
  for (const t of TEAMS) counts[t.code] = 0;
  for (const bar of Object.values(game.bars)) {
    if (bar.owner && counts[bar.owner] !== undefined) counts[bar.owner] += 1;
  }
  const final = {};
  for (const t of TEAMS) {
    const adj = Number(game.adjustments[t.code] || 0);
    final[t.code] = counts[t.code] + adj;
  }
  return { counts, final };
}
function broadcast() {
  io.emit("state", {
    teams: db.teams,
    games: Object.fromEntries(
      GAME_CODES.map(code => {
        const g = ensureGame(code);
        const scores = computeScores(g);
        return [code, { bars: g.bars, adjustments: g.adjustments, scores }];
      })
    ),
    gameCodes: GAME_CODES,
  });
}

// -------- Player API --------
app.post("/api/join", (req, res) => {
  const { gameCode, teamCode, displayName } = req.body;
  if (!gameCode || !validGame(gameCode)) return res.status(400).json({ error: "Enter a valid Game Code." });
  if (!teamCode || !TEAMS.find(t => t.code === teamCode)) return res.status(400).json({ error: "Enter a valid Team Code." });
  if (!displayName) return res.status(400).json({ error: "Enter your name." });
  ensureGame(gameCode);
  return res.json({ ok: true });
});

app.post("/api/claim", upload.single("teamPhoto"), (req, res) => {
  try {
    const { gameCode, teamCode, placeId, barName, lat, lng, action } = req.body;
    if (!validGame(gameCode)) return res.status(400).json({ error: "Bad game code." });
    if (!TEAMS.find(t => t.code === teamCode)) return res.status(400).json({ error: "Bad team code." });
    if (!placeId || !barName) return res.status(400).json({ error: "Missing bar info." });

    const game = ensureGame(gameCode);
    if (!game.bars[placeId]) {
      game.bars[placeId] = { name: barName, lat: Number(lat||0), lng: Number(lng||0), owner: null, locked: false };
    }
    const bar = game.bars[placeId];

    if (action === "lock") {
      if (bar.owner !== teamCode) return res.status(400).json({ error: "Only the owner can lock." });
      if (bar.locked) return res.status(400).json({ error: "Already locked." });
      bar.locked = true;
    } else if (action === "steal") {
      if (bar.locked) return res.status(400).json({ error: "Bar is locked." });
      if (!bar.owner) return res.status(400).json({ error: "Bar not claimed yet." });
      if (bar.owner === teamCode) return res.status(400).json({ error: "You already own it." });
      bar.owner = teamCode;
    } else {
      if (!req.file) return res.status(400).json({ error: "Team photo required for claim." });
      if (bar.locked) return res.status(400).json({ error: "Bar is locked." });
      if (bar.owner && bar.owner !== teamCode) {
        return res.status(400).json({ error: "Already claimed. Use Steal instead." });
      }
      bar.owner = teamCode;
    }

    saveDB();
    broadcast();
    res.json({ ok: true, bar });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message });
  }
});

// -------- Admin API --------
function requireAdmin(req, res, next) {
  const pass = req.headers["x-admin-secret"] || req.query.secret || req.body.secret;
  if (pass === ADMIN_PASSWORD) return next();
  return res.status(403).json({ error: "Forbidden" });
}

app.get("/api/admin/state", requireAdmin, (req, res) => {
  const gameCode = String(req.query.game || "");
  if (!validGame(gameCode)) return res.status(400).json({ error: "Invalid game code" });
  const game = ensureGame(gameCode);
  const scores = computeScores(game);
  res.json({ ok: true, teams: db.teams, gameCodes: GAME_CODES, gameCode, bars: game.bars, adjustments: game.adjustments, scores });
});

app.post("/api/admin/saveBars", requireAdmin, (req, res) => {
  const { gameCode, bars } = req.body;
  if (!validGame(gameCode)) return res.status(400).json({ error: "Invalid game code" });
  const game = ensureGame(gameCode);
  const next = {};
  if (Array.isArray(bars)) {
    for (const b of bars) {
      if (!b.placeId || !b.name) continue;
      next[b.placeId] = {
        name: String(b.name),
        lat: Number(b.lat||0),
        lng: Number(b.lng||0),
        owner: TEAMS.find(t => t.code === b.owner) ? b.owner : null,
        locked: !!b.locked
      };
    }
  }
  game.bars = next;
  saveDB(); broadcast();
  res.json({ ok: true });
});

app.post("/api/admin/saveAdjustments", requireAdmin, (req, res) => {
  const { gameCode, adjustments } = req.body;
  if (!validGame(gameCode)) return res.status(400).json({ error: "Invalid game code" });
  const game = ensureGame(gameCode);
  for (const t of TEAMS) {
    const v = adjustments && adjustments[t.code];
    if (v !== undefined) {
      game.adjustments[t.code] = Number(v) || 0;
    }
  }
  saveDB(); broadcast();
  res.json({ ok: true });
});

app.post("/api/admin/resetGame", requireAdmin, (req, res) => {
  const { gameCode } = req.body;
  if (!validGame(gameCode)) return res.status(400).json({ error: "Invalid game code" });
  const game = ensureGame(gameCode);
  game.bars = {};
  game.adjustments = {};
  for (const t of TEAMS) game.adjustments[t.code] = 0;
  saveDB(); broadcast();
  res.json({ ok: true });
});

// -------- Pages --------
// Player page (unchanged, trimmed for space)
app.get("/", (req, res) => {
  res.send(`<!doctype html><html><head> ... (player UI from before, unchanged) ... </html>`);
});

// Admin page (fixed escaping!)
app.get("/admin", (req, res) => {
  res.send(`<!doctype html><html><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>BFC Admin</title>
<style> body{background:#0f172a;color:#f8fafc;font-family:sans-serif} </style>
</head><body>
<h1>BFC Admin</h1>
<div id="login"><input id="pw" type="password"/><button onclick="login()">Enter</button></div>
<div id="panel" style="display:none">
  <select id="gameSel"></select><button onclick="loadGame()">Load</button><button onclick="resetGame()">Reset</button>
  <h2>Teams</h2><div id="teams"></div>
  <h2>Bars</h2><div id="bars"></div>
</div>
<script>
const TEAMS=${JSON.stringify(TEAMS)};
const GAMES=${JSON.stringify(GAME_CODES)};
let SECRET="",CUR=GAMES[0];
function login(){ if(document.getElementById('pw').value==='${ADMIN_PASSWORD}'){SECRET='${ADMIN_PASSWORD}';document.getElementById('login').style.display='none';document.getElementById('panel').style.display='block'; const s=document.getElementById('gameSel'); s.innerHTML=GAMES.map(g=>'<option>'+g+'</option>').join('');}}
async function loadGame(){CUR=document.getElementById('gameSel').value; const r=await fetch('/api/admin/state?game='+CUR,{headers:{'x-admin-secret':SECRET}}); const j=await r.json(); if(!j.ok){alert(j.error);return;} document.getElementById('teams').innerHTML=Object.values(TEAMS).map(t=>'<div>'+t.name+' ('+t.code+'): '+(j.scores.final[t.code]||0)+'</div>').join(''); document.getElementById('bars').innerHTML=Object.values(j.bars).map(b=>'<div>'+b.name+' — '+(b.owner||'Unclaimed')+(b.locked?' 🔒':'')+'</div>').join('');}
async function resetGame(){await fetch('/api/admin/resetGame',{method:'POST',headers:{'Content-Type':'application/json','x-admin-secret':SECRET},body:JSON.stringify({gameCode:CUR})}); loadGame();}
</script>
</body></html>`);
});

io.on("connection", () => broadcast());
server.listen(PORT, () => console.log("Battle for Canggu running on", PORT));

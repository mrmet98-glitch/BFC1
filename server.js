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
    const initial = {
      teams: TEAMS,         // static ref for UI
      games: {
        // [gameCode]: { bars: {placeId -> {name, lat, lng, owner, locked}}, adjustments: {teamCode -> number} }
      },
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
  }
  const json = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  if (!json.games) json.games = {};
  // Ensure games exist
  for (const code of GAME_CODES) {
    if (!json.games[code]) json.games[code] = { bars: {}, adjustments: {} };
  }
  // Ensure adjustments keys exist
  for (const code of GAME_CODES) {
    const g = json.games[code];
    if (!g.adjustments) g.adjustments = {};
    for (const t of TEAMS) if (g.adjustments[t.code] === undefined) g.adjustments[t.code] = 0;
  }
  // Keep team list in sync (names/colors)
  json.teams = TEAMS;
  fs.writeFileSync(DB_FILE, JSON.stringify(json, null, 2));
  return json;
}
function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
let db = loadDB();

// -------- Helpers --------
function validGame(code) {
  return GAME_CODES.includes(code);
}
function ensureGame(gameCode) {
  if (!validGame(gameCode)) throw new Error("Invalid game code");
  if (!db.games[gameCode]) db.games[gameCode] = { bars: {}, adjustments: {} };
  // make sure adjustments has all teams
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

// Join game (just validates codes; UI uses sockets to receive state)
app.post("/api/join", (req, res) => {
  const { gameCode, teamCode, displayName } = req.body;
  if (!gameCode || !validGame(gameCode)) return res.status(400).json({ error: "Enter a valid Game Code." });
  if (!teamCode || !TEAMS.find(t => t.code === teamCode)) return res.status(400).json({ error: "Enter a valid Team Code." });
  if (!displayName) return res.status(400).json({ error: "Enter your name." });
  ensureGame(gameCode); // lazy-init if needed
  return res.json({ ok: true });
});

// Claim/Steal/Lock
// action: "claim" (requires photo), "steal" (no photo), "lock" (no photo)
app.post("/api/claim", upload.single("teamPhoto"), (req, res) => {
  try {
    const { gameCode, teamCode, placeId, barName, lat, lng, action } = req.body;
    if (!validGame(gameCode)) return res.status(400).json({ error: "Bad game code." });
    if (!TEAMS.find(t => t.code === teamCode)) return res.status(400).json({ error: "Bad team code." });
    if (!placeId || !barName) return res.status(400).json({ error: "Missing bar info." });

    const game = ensureGame(gameCode);
    if (!game.bars[placeId]) {
      game.bars[placeId] = { name: barName, lat: Number(lat || 0), lng: Number(lng || 0), owner: null, locked: false };
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
      bar.owner = teamCode; // steals don't change score directly; score is derived from ownership
    } else {
      // "claim"
      if (!req.file) return res.status(400).json({ error: "Team photo required for claim." });
      if (bar.locked) return res.status(400).json({ error: "Bar is locked." });
      // Claim if unowned, otherwise ownership switches (treat as claim overwrite for simplicity? Better: if owned by someone else -> require steal)
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

// Get admin state for a game
app.get("/api/admin/state", requireAdmin, (req, res) => {
  const gameCode = String(req.query.game || "");
  if (!validGame(gameCode)) return res.status(400).json({ error: "Invalid game code" });
  const game = ensureGame(gameCode);
  const scores = computeScores(game);
  res.json({ ok: true, teams: db.teams, gameCodes: GAME_CODES, gameCode, bars: game.bars, adjustments: game.adjustments, scores });
});

// Save bars (owner/locked) — replaces existing bar set with provided list
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
        lat: Number(b.lat || 0),
        lng: Number(b.lng || 0),
        owner: TEAMS.find(t => t.code === b.owner) ? b.owner : null,
        locked: !!b.locked
      };
    }
  }
  game.bars = next;
  saveDB();
  broadcast();
  res.json({ ok: true });
});

// Save score adjustments (manual deltas)
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
  saveDB();
  broadcast();
  res.json({ ok: true });
});

// Reset a game (clears bars + adjustments)
app.post("/api/admin/resetGame", requireAdmin, (req, res) => {
  const { gameCode } = req.body;
  if (!validGame(gameCode)) return res.status(400).json({ error: "Invalid game code" });
  const game = ensureGame(gameCode);
  game.bars = {};
  game.adjustments = {};
  for (const t of TEAMS) game.adjustments[t.code] = 0;
  saveDB();
  broadcast();
  res.json({ ok: true });
});

// -------- Pages --------

// Player UI
app.get("/", (req, res) => {
  res.send(`<!doctype html><html><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no"/>
<title>Battle for Canggu</title>
<script src="/socket.io/socket.io.js"></script>
<script async src="https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_API_KEY}&libraries=places&callback=initMap"></script>
<style>
  :root{ --bg:#0f172a; --panel:#111827; --muted:#1f2937; --text:#f8fafc; --btn:#3b82f6; --btn2:#22c55e; --btn3:#f59e0b; }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif}
  h1{margin:0;padding:14px 10px;text-align:center;background:#1e293b}
  .wrap{padding:12px;max-width:900px;margin:0 auto}
  .card{background:var(--panel);border:1px solid var(--muted);border-radius:14px;padding:12px;margin:12px 0}
  input,button,select{font:inherit;border-radius:10px;border:1px solid var(--muted);background:#0b1220;color:var(--text);padding:10px 12px}
  button{border:none;background:var(--btn);cursor:pointer}
  button:hover{filter:brightness(1.05)}
  .row{display:flex;gap:10px;flex-wrap:wrap}
  .actions button{flex:1;min-width:110px}
  #map{height:52vh;border-radius:12px;border:1px solid var(--muted)}
  @media (max-width:640px){ #map{height:46vh} input,button,select{font-size:15px} }
  .small{opacity:.8;font-size:12px}
  .badge{padding:2px 8px;border-radius:999px;background:#0b1220;border:1px solid var(--muted);font-size:12px}
</style>
</head>
<body>
<h1>Battle for Canggu</h1>
<div class="wrap">

  <div class="card" id="join">
    <div class="row">
      <input id="gameCode" placeholder="Game Code (e.g., Testing123)" style="flex:1;min-width:200px"/>
      <input id="teamCode" placeholder="Team Code (e.g., NAP123)" style="flex:1;min-width:160px"/>
      <input id="displayName" placeholder="Your Name" style="flex:1;min-width:140px"/>
      <button onclick="joinGame()">Join</button>
    </div>
    <div class="small">Valid game codes: ${GAME_CODES.join(", ")}</div>
  </div>

  <div id="app" style="display:none">
    <div class="card">
      <div id="gameMeta" class="badge"></div>
    </div>

    <div class="card">
      <div id="map"></div>
      <div class="row" style="margin-top:10px">
        <input id="barSearch" placeholder="Search bar..." style="flex:1"/>
      </div>
      <div class="row" style="margin-top:10px">
        <input type="file" id="teamPhoto" accept="image/*" capture="environment" style="flex:1"/>
      </div>
      <div class="row actions" style="margin-top:10px">
        <button style="background:var(--btn2)" onclick="claim()">Claim (+1)</button>
        <button style="background:var(--btn3)" onclick="lockBar()">Lock</button>
        <button style="background:#8b5cf6" onclick="steal()">Steal</button>
      </div>
    </div>

    <div class="card">
      <h3>Leaderboard</h3>
      <ul id="scores" style="list-style:none;padding:0;margin:0"></ul>
    </div>

    <div class="card">
      <h3>Bars Claimed</h3>
      <ul id="barsList" style="list-style:none;padding:0;margin:0"></ul>
    </div>
  </div>

</div>

<script>
  const socket = io();
  let state = { games:{}, teams:[], gameCodes:[] };
  let me = { gameCode:null, teamCode:null, name:null };
  let map, autocomplete, selectedPlace=null;

  function initMap(){
    map = new google.maps.Map(document.getElementById("map"), { center:{lat:-8.65,lng:115.13}, zoom:14 });
    const input = document.getElementById("barSearch");
    autocomplete = new google.maps.places.Autocomplete(input);
    autocomplete.addListener("place_changed", ()=>{
      const p = autocomplete.getPlace();
      if(!p || !p.geometry) return;
      map.setCenter(p.geometry.location);
      new google.maps.Marker({ map, position: p.geometry.location });
      selectedPlace = {
        id: p.place_id,
        name: p.name,
        lat: p.geometry.location.lat(),
        lng: p.geometry.location.lng(),
      };
    });
  }

  function joinGame(){
    const gameCode = document.getElementById("gameCode").value.trim();
    const teamCode = document.getElementById("teamCode").value.trim();
    const displayName = document.getElementById("displayName").value.trim();
    fetch("/api/join", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ gameCode, teamCode, displayName })
    }).then(r=>r.json()).then(j=>{
      if(!j.ok){ alert(j.error||"Join failed"); return; }
      me = { gameCode, teamCode, name: displayName };
      document.getElementById("join").style.display = "none";
      document.getElementById("app").style.display = "block";
      document.getElementById("gameMeta").textContent = "Game: "+gameCode+"  •  Team: "+teamCode;
      render();
    });
  }

  function claim(){
    if(!me.gameCode) return alert("Join first.");
    if(!selectedPlace) return alert("Select a bar first!");
    const f = document.getElementById("teamPhoto").files[0];
    if(!f) return alert("Team photo required for claim.");
    const fd = new FormData();
    fd.append("gameCode", me.gameCode);
    fd.append("teamCode", me.teamCode);
    fd.append("placeId", selectedPlace.id);
    fd.append("barName", selectedPlace.name);
    fd.append("lat", selectedPlace.lat);
    fd.append("lng", selectedPlace.lng);
    fd.append("teamPhoto", f);
    fd.append("action", "claim");
    fetch("/api/claim",{ method:"POST", body: fd }).then(r=>r.json()).then(j=>{
      if(!j.ok) alert(j.error||"Claim failed"); else alert("Claimed!");
    });
  }

  function lockBar(){
    if(!me.gameCode) return alert("Join first.");
    if(!selectedPlace) return alert("Select a bar first!");
    const fd = new FormData();
    fd.append("gameCode", me.gameCode);
    fd.append("teamCode", me.teamCode);
    fd.append("placeId", selectedPlace.id);
    fd.append("barName", selectedPlace.name);
    fd.append("lat", selectedPlace.lat);
    fd.append("lng", selectedPlace.lng);
    fd.append("action", "lock");
    fetch("/api/claim",{ method:"POST", body: fd }).then(r=>r.json()).then(j=>{
      if(!j.ok) alert(j.error||"Lock failed"); else alert("Locked!");
    });
  }

  function steal(){
    if(!me.gameCode) return alert("Join first.");
    if(!selectedPlace) return alert("Select a bar first!");
    const fd = new FormData();
    fd.append("gameCode", me.gameCode);
    fd.append("teamCode", me.teamCode);
    fd.append("placeId", selectedPlace.id);
    fd.append("barName", selectedPlace.name);
    fd.append("lat", selectedPlace.lat);
    fd.append("lng", selectedPlace.lng);
    fd.append("action", "steal");
    fetch("/api/claim",{ method:"POST", body: fd }).then(r=>r.json()).then(j=>{
      if(!j.ok) alert(j.error||"Steal failed"); else alert("Stolen!");
    });
  }

  socket.on("state", s => { state = s; render(); });

  function render(){
    if(!me.gameCode || !state.games || !state.games[me.gameCode]) return;
    const g = state.games[me.gameCode];
    const teamsByCode = Object.fromEntries(state.teams.map(t=>[t.code,t]));

    // Leaderboard
    const arr = state.teams.map(t => ({
      code: t.code, name: t.name, color: t.color,
      score: (g.scores?.final?.[t.code]) ?? 0
    })).sort((a,b)=>b.score-a.score);

    const ul = document.getElementById("scores");
    ul.innerHTML = "";
    arr.forEach(t=>{
      const li = document.createElement("li");
      li.textContent = `${t.name} — ${t.score} pts`;
      li.style.color = t.color;
      ul.appendChild(li);
    });

    // Bars list
    const bl = document.getElementById("barsList");
    bl.innerHTML = "";
    Object.entries(g.bars).forEach(([pid, b])=>{
      const li = document.createElement("li");
      const ownerName = b.owner ? (teamsByCode[b.owner]?.name || b.owner) : "Unclaimed";
      const status = b.locked ? " 🔒" : "";
      li.textContent = `${b.name} — ${ownerName}${status}`;
      bl.appendChild(li);
    });
  }
</script>
</body></html>`);
});

// Admin UI (password: raju123)
app.get("/admin", (req, res) => {
  res.send(`<!doctype html><html><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>BFC Admin</title>
<style>
  body{font-family:system-ui,Arial,sans-serif;background:#0f172a;color:#f8fafc;margin:0}
  .wrap{max-width:1000px;margin:0 auto;padding:16px}
  h1{margin:0;background:#1e293b;padding:12px 16px}
  .card{background:#111827;border:1px solid #1f2937;border-radius:14px;padding:14px;margin:12px 0}
  label{display:block;margin:8px 0 4px}
  input,select,button{font:inherit;padding:8px 10px;border-radius:10px;border:1px solid #374151;background:#0b1220;color:#f8fafc}
  button{background:#3b82f6;border:none;cursor:pointer}
  button.danger{background:#b91c1c}
  table{width:100%;border-collapse:collapse}
  th,td{border-bottom:1px solid #1f2937;padding:6px 8px;text-align:left}
  .row{display:flex;gap:10px;flex-wrap:wrap}
</style>
</head><body>
<h1>BFC Admin</h1>
<div class="wrap">
  <div class="card" id="login">
    <label>Admin Password</label>
    <input id="pw" type="password" placeholder="••••••••"/>
    <button onclick="login()">Enter</button>
  </div>

  <div id="panel" style="display:none">
    <div class="card">
      <label>Game</label>
      <select id="gameSel"></select>
      <button onclick="loadGame()">Load</button>
      <button class="danger" onclick="resetGame()">Reset Game</button>
    </div>

    <div class="card">
      <h3>Teams & Score Adjustments</h3>
      <table id="teamsTbl"><thead><tr><th>Team</th><th>Owned Bars</th><th>Adj</th><th>Total</th></tr></thead><tbody></tbody></table>
      <button onclick="saveAdjustments()">Save Adjustments</button>
    </div>

    <div class="card">
      <h3>Bars</h3>
      <table id="barsTbl"><thead><tr><th>Name</th><th>Owner</th><th>Locked</th></tr></thead><tbody></tbody></table>
      <button onclick="saveBars()">Save Bars</button>
    </div>
  </div>
</div>

<script>
  const TEAMS = ${JSON.stringify(TEAMS)};
  const GAME_CODES = ${JSON.stringify(GAME_CODES)};
  let SECRET = "";
  let CURRENT_GAME = GAME_CODES[0];
  let ADMIN_STATE = null;

  function login(){
    SECRET = document.getElementById('pw').value;
    if(SECRET !== '${ADMIN_PASSWORD}') return alert('Wrong password');
    document.getElementById('login').style.display='none';
    document.getElementById('panel').style.display='block';
    const sel = document.getElementById('gameSel');
    sel.innerHTML = GAME_CODES.map(c => '<option>'+c+'</option>').join('');
    sel.value = CURRENT_GAME;
    loadGame();
  }

  async function loadGame(){
    CURRENT_GAME = document.getElementById('gameSel').value;
    const r = await fetch('/api/admin/state?game='+encodeURIComponent(CURRENT_GAME), { headers:{'x-admin-secret': SECRET }});
    const j = await r.json();
    if(!j.ok){ alert(j.error||'Load failed'); return; }
    ADMIN_STATE = j;
    renderTeams();
    renderBars();
  }

  function renderTeams(){
    const tb = document.querySelector('#teamsTbl tbody');
    tb.innerHTML = '';
    const counts = ADMIN_STATE.scores.counts || {};
    const final  = ADMIN_STATE.scores.final  || {};
    const adj    = ADMIN_STATE.adjustments   || {};
    TEAMS.forEach(t=>{
      const tr = document.createElement('tr');
      tr.innerHTML = \`
        <td>\${t.name} (\${t.code})</td>
        <td>\${counts[t.code]||0}</td>
        <td><input style="width:80px" value="\${adj[t.code]||0}" data-team="\${t.code}" class="adj"/></td>
        <td>\${final[t.code]||0}</td>\`;
      tb.appendChild(tr);
    });
  }

  function renderBars(){
    const tb = document.querySelector('#barsTbl tbody');
    tb.innerHTML = '';
    const bars = ADMIN_STATE.bars || {};
    const codes = TEAMS.map(t=>t.code);
    Object.entries(bars).forEach(([pid,b])=>{
      const tr = document.createElement('tr');
      const ownerSel = '<select class="owner" data-pid="'+pid+'"><option value="">Unclaimed</option>'+TEAMS.map(t=>'<option '+(b.owner===t.code?'selected':'')+' value="'+t.code+'">'+t.name+' ('+t.code+')</option>').join('')+'</select>';
      const lockChk = '<input type="checkbox" class="locked" data-pid="'+pid+'" '+(b.locked?'checked':'')+' />';
      tr.innerHTML = '<td>'+b.name+'</td><td>'+ownerSel+'</td><td style="text-align:center">'+lockChk+'</td>';
      tb.appendChild(tr);
    });
  }

  async function saveAdjustments(){
    const inputs = Array.from(document.querySelectorAll('.adj'));
    const payload = {};
    inputs.forEach(i => payload[i.dataset.team] = Number(i.value||0));
    const r = await fetch('/api/admin/saveAdjustments', {
      method:'POST',
      headers:{'Content-Type':'application/json','x-admin-secret':SECRET},
      body: JSON.stringify({ gameCode: CURRENT_GAME, adjustments: payload })
    });
    const j = await r.json();
    if(!j.ok) return alert(j.error||'Save failed');
    alert('Adjustments saved');
    await loadGame();
  }

  async function saveBars(){
    const rows = Array.from(document.querySelectorAll('#barsTbl tbody tr'));
    const bars = rows.map(tr => {
      const name = tr.children[0].innerText;
      const ownerSel = tr.querySelector('.owner');
      const locked = tr.querySelector('.locked').checked;
      const placeId = ownerSel.dataset.pid;
      const b = ADMIN_STATE.bars[placeId] || {};
      return { placeId, name, lat: b.lat||0, lng: b.lng||0, owner: ownerSel.value || null, locked };
    });
    const r = await fetch('/api/admin/saveBars', {
      method:'POST',
      headers:{'Content-Type':'application/json','x-admin-secret':SECRET},
      body: JSON.stringify({ gameCode: CURRENT_GAME, bars })
    });
    const j = await r.json();
    if(!j.ok) return alert(j.error||'Save failed');
    alert('Bars saved');
    await loadGame();
  }

  async function resetGame(){
    if(!confirm('Reset '+CURRENT_GAME+'? This clears bars and sets adjustments to 0.')) return;
    const r = await fetch('/api/admin/resetGame', {
      method:'POST',
      headers:{'Content-Type':'application/json','x-admin-secret':SECRET},
      body: JSON.stringify({ gameCode: CURRENT_GAME })
    });
    const j = await r.json();
    if(!j.ok) return alert(j.error||'Reset failed');
    alert('Game reset');
    await loadGame();
  }
</script>
</body></html>`);
});

// ---------- Socket boot + initial broadcast ----------
io.on("connection", () => {
  // send current state
  broadcast();
});

server.listen(PORT, () => {
  console.log("Battle for Canggu running on port", PORT);
});

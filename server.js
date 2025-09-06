// server.js
// Battle for Canggu simplified version
// - 4 preconfigured teams with join codes
// - One team photo required for claims
// - No challenge deck logic (using physical cards)

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || "";
const ADMIN_SECRET = process.env.GAME_ADMIN_SECRET || "";
const ENV_GAME_ACCESS_CODE = process.env.GAME_ACCESS_CODE || "";

// ==== PRECONFIGURED TEAMS ====
const TEAMS_CONFIG = [
  { code: "NAP123", name: "Raj's Nap Champs", color: "#ef4444" },
  { code: "PUMP456", name: "Raj's Pumpers & Dumpers", color: "#f59e0b" },
  { code: "ROCK789", name: "Raj on the Rocks", color: "#22c55e" },
  { code: "RAJMA777", name: "Big Rajma", color: "#3b82f6" },
];
// ==============================

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static uploads
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
app.use("/uploads", express.static(uploadsDir));

// Simple JSON DB
const DB_FILE = path.join(__dirname, "db.json");
function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = {
      game: { accessCode: ENV_GAME_ACCESS_CODE || "", start: null, end: null },
      teams: {},
      bars: {}
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}
function saveDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
let db = loadDB();

// Seed teams from config
function syncTeams() {
  if (!db.teams) db.teams = {};
  for (const t of TEAMS_CONFIG) {
    if (!db.teams[t.code]) {
      db.teams[t.code] = { name: t.name, color: t.color, score: 0 };
    } else {
      db.teams[t.code].name = t.name;
      db.teams[t.code].color = t.color;
    }
  }
  saveDB(db);
}
syncTeams();

function broadcastState() {
  io.emit("state", { game: db.game, teams: db.teams, bars: db.bars });
}

function ensureTeam(teamCode) {
  const t = db.teams[teamCode];
  if (!t) throw new Error("Invalid team.");
  return t;
}

// Multer setup for team photo
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^\w.\-]+/g, "_");
    cb(null, Date.now() + "_" + safe);
  },
});
const upload = multer({ storage });

// ---------- Admin ----------
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

app.post("/api/admin/resetState", requireAdmin, (req, res) => {
  db.bars = {};
  for (const code of Object.keys(db.teams)) {
    db.teams[code].score = 0;
  }
  saveDB(db);
  broadcastState();
  res.json({ ok: true });
});

// ---------- Player Join ----------
app.post("/api/join", (req, res) => {
  const { accessCode, teamCode, displayName } = req.body;
  if (!teamCode || !displayName) return res.status(400).json({ error: "teamCode and displayName required." });

  if (db.game.accessCode && accessCode !== db.game.accessCode) {
    return res.status(403).json({ error: "Bad access code." });
  }

  const cfg = TEAMS_CONFIG.find(t => t.code === teamCode);
  if (!cfg) return res.status(400).json({ error: "Unknown team code." });

  syncTeams();
  res.json({ ok: true, team: db.teams[teamCode] });
});

// ---------- Claim a bar ----------
app.post("/api/claim", upload.single("teamPhoto"), (req, res) => {
  try {
    const { teamCode, placeId, barName, lat, lng } = req.body;
    if (!teamCode) return res.status(400).json({ error: "Missing teamCode" });
    if (!req.file) return res.status(400).json({ error: "Team photo required" });

    const team = ensureTeam(teamCode);
    if (!db.bars[placeId]) {
      db.bars[placeId] = { name: barName, lat, lng, owner: null, locked: false };
    }

    const bar = db.bars[placeId];
    if (bar.locked) return res.status(400).json({ error: "Bar is locked" });

    // Claim or steal
    if (!bar.owner) {
      bar.owner = teamCode;
      team.score += 1;
    } else if (bar.owner !== teamCode) {
      // Steal rule
      bar.owner = teamCode;
      // no extra point for steal in this version
    }

    saveDB(db);
    broadcastState();
    res.json({ ok: true, bar });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// ---------- Pages ----------
app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8"/>
      <title>Battle for Canggu</title>
      <script src="/socket.io/socket.io.js"></script>
      <script async
        src="https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_API_KEY}&libraries=places&callback=initMap">
      </script>
      <style>
        body { font-family: sans-serif; margin:0; }
        #map { height:60vh; }
      </style>
    </head>
    <body>
      <h1>Battle for Canggu</h1>
      <div>
        <label>Game Code: <input id="accessCode"/></label>
        <label>Team Code: <input id="teamCode"/></label>
        <label>Your Name: <input id="displayName"/></label>
        <button onclick="join()">Join</button>
      </div>
      <div id="joined" style="display:none;">
        <div id="map"></div>
        <input id="barSearch" placeholder="Search bar..."/>
        <br/>
        <input type="file" id="teamPhoto" accept="image/*" capture="environment"/>
        <button onclick="claim()">Claim Bar</button>
        <h2>Leaderboard</h2>
        <ul id="scores"></ul>
      </div>
      <script>
        const socket = io();
        let state={}, me={};

        function join(){
          fetch("/api/join",{method:"POST",headers:{"Content-Type":"application/json"},
            body:JSON.stringify({
              accessCode:document.getElementById("accessCode").value,
              teamCode:document.getElementById("teamCode").value,
              displayName:document.getElementById("displayName").value
            })})
          .then(r=>r.json()).then(d=>{
            if(d.ok){ me=d.team; document.getElementById("joined").style.display="block"; }
            else alert(d.error);
          });
        }

        let map, autocomplete, selectedPlace=null;
        function initMap(){
          map=new google.maps.Map(document.getElementById("map"),{center:{lat:-8.65,lng:115.13},zoom:14});
          const input=document.getElementById("barSearch");
          autocomplete=new google.maps.places.Autocomplete(input);
          autocomplete.addListener("place_changed",()=>{
            const place=autocomplete.getPlace();
            if(!place.geometry){return;}
            map.setCenter(place.geometry.location);
            new google.maps.Marker({map:map,position:place.geometry.location});
            selectedPlace={id:place.place_id,name:place.name,lat:place.geometry.location.lat(),lng:place.geometry.location.lng()};
          });
        }

        function claim(){
          if(!selectedPlace){alert("Select a bar first!");return;}
          const fd=new FormData();
          fd.append("teamCode",document.getElementById("teamCode").value);
          fd.append("placeId",selectedPlace.id);
          fd.append("barName",selectedPlace.name);
          fd.append("lat",selectedPlace.lat);
          fd.append("lng",selectedPlace.lng);
          const file=document.getElementById("teamPhoto").files[0];
          if(!file){alert("Take a team photo!");return;}
          fd.append("teamPhoto",file);
          fetch("/api/claim",{method:"POST",body:fd}).then(r=>r.json()).then(d=>{
            if(!d.ok) alert(d.error); else alert("Claimed!");
          });
        }

        socket.on("state",s=>{
          state=s;
          const ul=document.getElementById("scores"); ul.innerHTML="";
          Object.values(s.teams).forEach(t=>{
            const li=document.createElement("li");
            li.textContent=t.name+" — "+t.score+" pts";
            ul.appendChild(li);
          });
        });
      </script>
    </body>
    </html>
  `);
});

server.listen(PORT, () => console.log("Battle for Canggu running on port", PORT));


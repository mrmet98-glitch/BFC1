// server.js
// Battle for Canggu with enforced Game Codes + Bars List

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || "";
const ADMIN_SECRET = process.env.GAME_ADMIN_SECRET || "";

// ==== PRECONFIGURED TEAMS ====
const TEAMS_CONFIG = [
  { code: "NAP123", name: "Raj's Nap Champs", color: "#ef4444" },
  { code: "PUMP456", name: "Raj's Pumpers & Dumpers", color: "#f59e0b" },
  { code: "ROCK789", name: "Raj on the Rocks", color: "#22c55e" },
  { code: "RAJMA777", name: "Big Rajma", color: "#3b82f6" },
];
// ==============================

// ==== GAME CODES ====
// For testing vs real play. Change ACTIVE_GAME_CODE when ready.
const GAME_CODES = {
  test: "Testing123",
  live: "rajuiskadak",
};
let ACTIVE_GAME_CODE = GAME_CODES.test; // default is test
// ===================

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
    const initial = { teams: {}, bars: {} };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}
function saveDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
let db = loadDB();

// Seed teams
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
  io.emit("state", { gameCode: ACTIVE_GAME_CODE, teams: db.teams, bars: db.bars });
}
function ensureTeam(teamCode) {
  const t = db.teams[teamCode];
  if (!t) throw new Error("Invalid team.");
  return t;
}

// Multer setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^\w.\-]+/g, "_");
    cb(null, Date.now() + "_" + safe);
  },
});
const upload = multer({ storage });

// ---------- Player Join ----------
app.post("/api/join", (req, res) => {
  const { accessCode, teamCode, displayName } = req.body;
  if (!accessCode || accessCode !== ACTIVE_GAME_CODE) {
    return res.status(403).json({ error: "Invalid game code." });
  }
  if (!teamCode || !displayName) return res.status(400).json({ error: "teamCode and displayName required." });

  const cfg = TEAMS_CONFIG.find(t => t.code === teamCode);
  if (!cfg) return res.status(400).json({ error: "Unknown team code." });

  syncTeams();
  res.json({ ok: true, team: db.teams[teamCode] });
});

// ---------- Claim / Lock ----------
app.post("/api/claim", upload.single("teamPhoto"), (req, res) => {
  try {
    const { teamCode, placeId, barName, lat, lng, action } = req.body;
    if (!teamCode) return res.status(400).json({ error: "Missing teamCode" });
    if (!req.file && action === "claim") return res.status(400).json({ error: "Team photo required" });

    const team = ensureTeam(teamCode);
    if (!db.bars[placeId]) {
      db.bars[placeId] = { name: barName, lat, lng, owner: null, locked: false };
    }

    const bar = db.bars[placeId];

    if (action === "lock") {
      if (bar.owner !== teamCode) return res.status(400).json({ error: "Only the owner can lock" });
      if (bar.locked) return res.status(400).json({ error: "Already locked" });
      bar.locked = true;
    } else {
      if (bar.locked) return res.status(400).json({ error: "Bar is locked" });

      if (!bar.owner) {
        bar.owner = teamCode;
        team.score += 1;
      } else if (bar.owner !== teamCode) {
        bar.owner = teamCode; // steal
      }
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
        body { font-family: system-ui, sans-serif; margin:0; background:#0f172a; color:#f8fafc; }
        h1 { text-align:center; padding:12px; background:#1e293b; margin:0; }
        #map { height:50vh; width:100%; }
        .container { padding:10px; }
        input, button { margin:6px 0; padding:10px; font-size:16px; border-radius:8px; border:none; }
        input { width:100%; max-width:300px; }
        button { background:#3b82f6; color:white; cursor:pointer; transition: background 0.2s; }
        button:hover { background:#2563eb; }
        #actions { display:flex; flex-wrap:wrap; gap:10px; margin-top:10px; }
        #actions button { flex:1; min-width:100px; }
        ul { list-style:none; padding:0; }
        li { margin:4px 0; }
        #barsList { margin-top:20px; }
        @media(max-width:600px){
          #map { height:40vh; }
          input, button { font-size:14px; }
        }
      </style>
    </head>
    <body>
      <h1>Battle for Canggu</h1>
      <div class="container">
        <div id="joinForm">
          <input id="accessCode" placeholder="Game Code"/>
          <input id="teamCode" placeholder="Team Code"/>
          <input id="displayName" placeholder="Your Name"/>
          <button onclick="join()">Join</button>
        </div>
        <div id="gameUI" style="display:none;">
          <div id="map"></div>
          <input id="barSearch" placeholder="Search bar..."/>
          <input type="file" id="teamPhoto" accept="image/*" capture="environment"/>
          <div id="actions">
            <button onclick="claim()">Claim (+1)</button>
            <button onclick="lockBar()">Lock</button>
            <button onclick="steal()">Steal</button>
          </div>
          <h2>Leaderboard</h2>
          <ul id="scores"></ul>
          <h2>Bars Claimed</h2>
          <ul id="barsList"></ul>
        </div>
      </div>
      <script>
        const socket = io();
        let state={}, me={}, selectedPlace=null;

        function join(){
          fetch("/api/join",{method:"POST",headers:{"Content-Type":"application/json"},
            body:JSON.stringify({
              accessCode:document.getElementById("accessCode").value,
              teamCode:document.getElementById("teamCode").value,
              displayName:document.getElementById("displayName").value
            })})
          .then(r=>r.json()).then(d=>{
            if(d.ok){
              me.teamCode=document.getElementById("teamCode").value;
              document.getElementById("joinForm").style.display="none";
              document.getElementById("gameUI").style.display="block";
            } else alert(d.error);
          });
        }

        function initMap(){
          const map=new google.maps.Map(document.getElementById("map"),{center:{lat:-8.65,lng:115.13},zoom:14});
          const input=document.getElementById("barSearch");
          const autocomplete=new google.maps.places.Autocomplete(input);
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
          fd.append("teamCode",me.teamCode);
          fd.append("placeId",selectedPlace.id);
          fd.append("barName",selectedPlace.name);
          fd.append("lat",selectedPlace.lat);
          fd.append("lng",selectedPlace.lng);
          const file=document.getElementById("teamPhoto").files[0];
          if(!file){alert("Take a team photo!");return;}
          fd.append("teamPhoto",file);
          fd.append("action","claim");
          fetch("/api/claim",{method:"POST",body:fd}).then(r=>r.json()).then(d=>{
            if(!d.ok) alert(d.error); else alert("Claimed!");
          });
        }

        function lockBar(){
          if(!selectedPlace){alert("Select a bar first!");return;}
          const fd=new FormData();
          fd.append("teamCode",me.teamCode);
          fd.append("placeId",selectedPlace.id);
          fd.append("barName",selectedPlace.name);
          fd.append("lat",selectedPlace.lat);
          fd.append("lng",selectedPlace.lng);
          fd.append("action","lock");
          fetch("/api/claim",{method:"POST",body:fd}).then(r=>r.json()).then(d=>{
            if(!d.ok) alert(d.error); else alert("Locked!");
          });
        }

        function steal(){
          if(!selectedPlace){alert("Select a bar first!");return;}
          const fd=new FormData();
          fd.append("teamCode",me.teamCode);
          fd.append("placeId",selectedPlace.id);
          fd.append("barName",selectedPlace.name);
          fd.append("lat",selectedPlace.lat);
          fd.append("lng",selectedPlace.lng);
          fd.append("action","claim");
          fetch("/api/claim",{method:"POST",body:fd}).then(r=>r.json()).then(d=>{
            if(!d.ok) alert(d.error); else alert("Stolen!");
          });
        }

        socket.on("state",s=>{
          state=s;
          const ul=document.getElementById("scores"); ul.innerHTML="";
          Object.values(s.teams).forEach(t=>{
            const li=document.createElement("li");
            li.textContent=t.name+" — "+t.score+" pts";
            li.style.color=t.color;
            ul.appendChild(li);
          });
          const barsUl=document.getElementById("barsList"); barsUl.innerHTML="";
          Object.values(s.bars).forEach(b=>{
            const li=document.createElement("li");
            let status = b.locked ? " (Locked)" : "";
            let owner = b.owner ? state.teams[b.owner].name : "Unclaimed";
            li.textContent = b.name + " — " + owner + status;
            barsUl.appendChild(li);
          });
        });
      </script>
    </body>
    </html>
  `);
});

server.listen(PORT, () => console.log("Battle for Canggu running on port", PORT));

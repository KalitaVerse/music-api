import express from "express";
import fetch from "node-fetch";
import { WebSocketServer, WebSocket } from "ws";

const app = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────────────────────────────
// 1. MIRROR REGISTRY (Saavn + iTunes + Deezer)
// ─────────────────────────────────────────────────────────────────────────────
const MIRRORS = [
  {
    name: "kalita-own",
    url: (q) => `https://jiosaavn-n0ivatwvc-kalitaverses-projects.vercel.app/api/search/songs?query=${encodeURIComponent(q)}&limit=50`,
    parse: (raw) => raw?.data?.results ?? null,
  },
  {
    name: "saavn-me",
    url: (q) => `https://saavn.me/api/search/songs?query=${encodeURIComponent(q)}&limit=50`,
    parse: (raw) => raw?.data?.results ?? null,
  },
  {
    name: "rajput-hemant",
    url: (q) => `https://jiosaavn-api-ts.vercel.app/api/search/songs?query=${encodeURIComponent(q)}&limit=50`,
    parse: (raw) => raw?.data?.results ?? null,
  },
  {
    name: "jiosaavn-beta",
    url: (q) => `https://jiosaavn-api-beta.vercel.app/api/search/songs?query=${encodeURIComponent(q)}&limit=50`,
    parse: (raw) => raw?.data?.results ?? null,
  },
  {
    name: "itunes",
    url: (q) => `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&limit=20`,
    parse: (raw) => {
      if (!Array.isArray(raw?.results)) return null;
      return raw.results.map((s) => ({
        id: s.trackId?.toString(),
        name: s.trackName,
        artists: { primary: [{ name: s.artistName }] },
        image: [
          { quality: "100x100", url: s.artworkUrl100 },
          { quality: "600x600", url: s.artworkUrl100?.replace("100x100", "600x600") },
        ],
        downloadUrl: s.previewUrl ? [{ quality: "preview", url: s.previewUrl }] : [],
        duration: Math.floor((s.trackTimeMillis ?? 0) / 1000).toString(),
        album: s.collectionName,
      }));
    },
  },
  {
    name: "deezer",
    url: (q) => `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=20`,
    parse: (raw) => {
      if (!Array.isArray(raw?.data)) return null;
      return raw.data.map((s) => ({
        id: s.id?.toString(),
        name: s.title,
        artists: { primary: [{ name: s.artist?.name }] },
        image: [
          { quality: "small", url: s.album?.cover_small },
          { quality: "big", url: s.album?.cover_big },
        ],
        downloadUrl: s.preview ? [{ quality: "preview", url: s.preview }] : [],
        duration: s.duration?.toString(),
        album: s.album?.title,
      }));
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 2. SEARCH LOGIC (Race + Timeout + Shuffle)
// ─────────────────────────────────────────────────────────────────────────────
const buildActiveMirrors = () => {
  const primary = MIRRORS[0];
  const critical = MIRRORS.filter((m) => m.name === "itunes" || m.name === "deezer");
  const others = MIRRORS.filter((m) => !["itunes", "deezer", primary.name].includes(m.name))
                        .sort(() => Math.random() - 0.5);
  return [primary, ...others.slice(0, 2), ...critical];
};

const fetchWithTimeout = (mirror, q, ms = 4000) => {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); reject(new Error(`Timeout: ${mirror.name}`)); }, ms);

    fetch(mirror.url(q), { signal: controller.signal })
      .then(async (res) => {
        clearTimeout(timer);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const parsed = mirror.parse(await res.json());
        if (parsed?.length > 0) resolve(parsed);
        else reject(new Error(`Empty: ${mirror.name}`));
      })
      .catch((err) => { clearTimeout(timer); reject(err); });
  });
};

app.get("/search", async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: "Missing query" });

  try {
    const results = await Promise.any(buildActiveMirrors().map((m) => fetchWithTimeout(m, q)));
    const seen = new Set();
    const unique = [];

    for (const s of results) {
      const artist = s.artists?.primary?.[0]?.name ?? "";
      const key = `${s.name}-${artist}`.toLowerCase();
      if (!seen.has(key)) { seen.add(key); unique.push(s); }
    }
    return res.json({ data: unique.slice(0, 50) });
  } catch (err) {
    return res.status(502).json({ error: "Search failed. Try again." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. WEBSOCKET SYNC LOGIC (With Room State Memory)
// ─────────────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
const wss = new WebSocketServer({ server });
const rooms = new Map(); // Map<roomCode, { members: Set, state: Object }>

wss.on("connection", (ws) => {
  let joinedRoom = null;
  ws.isAlive = true;
  ws.on("pong", () => ws.isAlive = true);

  ws.on("message", (raw) => {
    const data = JSON.parse(raw.toString());
    if (data.type === "ping") return; // Keep-alive heartbeat

    const { type, room } = data;

    switch (type) {
      case "join":
        if (joinedRoom) { /* cleanup logic */ }
        if (!rooms.has(room)) rooms.set(room, { members: new Set(), state: null });
        
        const roomData = rooms.get(room);
        roomData.members.add(ws);
        joinedRoom = room;

        // Catch-up: Send existing song/state to the new member immediately
        if (roomData.state) {
          ws.send(JSON.stringify({ ...roomData.state, serverTime: Date.now() }));
        }
        
        // Broadcast new member count
        const msg = JSON.stringify({ type: "joined", room, members: roomData.members.size });
        roomData.members.forEach(client => { if(client.readyState === WebSocket.OPEN) client.send(msg); });
        break;

      case "play":
      case "pause":
      case "resume":
      case "seek":
        if (joinedRoom && rooms.has(joinedRoom)) {
          const r = rooms.get(joinedRoom);
          r.state = data; // Save state for new joiners
          const stamped = JSON.stringify({ ...data, serverTime: Date.now() });
          r.members.forEach(c => { if(c !== ws && c.readyState === WebSocket.OPEN) c.send(stamped); });
        }
        break;
    }
  });

  ws.on("close", () => {
    if (joinedRoom && rooms.has(joinedRoom)) {
      const r = rooms.get(joinedRoom);
      r.members.delete(ws);
      if (r.members.size === 0) rooms.delete(joinedRoom);
    }
  });
});

// Heartbeat cleanup
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
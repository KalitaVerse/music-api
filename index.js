import express from "express";
import fetch from "node-fetch";
import { WebSocketServer, WebSocket } from "ws";

const app = express();
const PORT = process.env.PORT || 3000;

const CACHE = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// 1. MIRROR REGISTRY
//    Primary  : JioSaavn mirrors  → full stream URLs, 40-50 results
//    Fallback : iTunes & Deezer   → metadata only (cover, artist, album)
//                                   downloadUrl is intentionally [] so the
//                                   Flutter client shows the card but never
//                                   plays a 30-sec preview.
// ─────────────────────────────────────────────────────────────────────────────
const MIRRORS = [
  // ── Primary: full stream URLs ─────────────────────────────────────────────
  {
    name: "kalita-own",
    url: (q) =>
      `https://jiosaavn-n0ivatwvc-kalitaverses-projects.vercel.app/api/search/songs?query=${encodeURIComponent(q)}&limit=50`,
    parse: (raw) => raw?.data?.results ?? null,
  },
  {
    name: "jiosaavn-self",
    url: (q) =>
      `https://jiosaavn-go-brr.mmanojkalita7.workers.dev/api/search/songs?query=${encodeURIComponent(q)}&limit=50`,
    parse: (raw) => raw?.data?.results ?? null,
  },
  {
    // rajput-hemant's API — uses different field names so we normalize them
    // to match what the Flutter app expects:
    //   image[].link      → image[].url
    //   artist_map.artists → artists.primary
    //   download_url[].link → downloadUrl[].url
    name: "heyjiosaanv",
    url: (q) =>
      `https://heyjiosaanv.vercel.app/search/songs?q=${encodeURIComponent(q)}&limit=50`,
    parse: (raw) => {
      const results = raw?.data?.results;
      if (!Array.isArray(results) || results.length === 0) return null;
      return results.map((s) => ({
        id: s.id,
        name: s.name,
        duration: s.duration?.toString(),
        artists: {
          primary: (s.artist_map?.artists ?? []).map((a) => ({
            name: a.name,
          })),
        },
        image: (s.image ?? []).map((img) => ({
          quality: img.quality,
          url: img.link ?? img.url, // this API uses "link" not "url"
        })),
        // Handles both possible field names: download_url (new) or downloadUrl (old)
        // Each entry uses "link" instead of "url" — normalize both
        downloadUrl: (s.download_url ?? s.downloadUrl ?? []).map((u) => ({
          quality: u.quality,
          url: u.link ?? u.url,
        })),
      }));
    },
  },

  // ── Metadata-only fallbacks ───────────────────────────────────────────────
  // downloadUrl is always [] — Flutter shows the song card (name, artist,
  // album, cover art) but _playSong will throw "No download URLs" and show
  // "Cannot play this song." — no 30-sec preview ever plays.
  {
    name: "itunes",
    url: (q) =>
      `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&limit=20`,
    parse: (raw) => {
      if (!Array.isArray(raw?.results)) return null;
      return raw.results.map((s) => ({
        id: s.trackId?.toString(),
        name: s.trackName,
        artists: { primary: [{ name: s.artistName }] },
        image: [
          { quality: "100x100", url: s.artworkUrl100 },
          {
            quality: "600x600",
            url: s.artworkUrl100?.replace("100x100", "600x600"),
          },
        ],
        downloadUrl: [], // intentionally empty — no preview playback
        duration: Math.floor((s.trackTimeMillis ?? 0) / 1000).toString(),
        album: { name: s.collectionName },
      }));
    },
  },
  {
    name: "deezer",
    url: (q) =>
      `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=20`,
    parse: (raw) => {
      if (!Array.isArray(raw?.data)) return null;
      return raw.data.map((s) => ({
        id: s.id?.toString(),
        name: s.title,
        artists: { primary: [{ name: s.artist?.name }] },
        image: [
          { quality: "small",  url: s.album?.cover_small  },
          { quality: "medium", url: s.album?.cover_medium },
          { quality: "big",    url: s.album?.cover_big    },
        ],
        downloadUrl: [], // intentionally empty — no preview playback
        duration: s.duration?.toString(),
        album: { name: s.album?.title },
      }));
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 2. SEARCH LOGIC
//    JioSaavn mirrors race first (full songs).
//    iTunes & Deezer are appended last — used only if all JioSaavn mirrors fail.
// ─────────────────────────────────────────────────────────────────────────────
const buildActiveMirrors = () => {
  const saavn = MIRRORS.filter(
    (m) => m.name !== "itunes" && m.name !== "deezer"
  ).sort(() => Math.random() - 0.5);

  const fallback = MIRRORS.filter(
    (m) => m.name === "itunes" || m.name === "deezer"
  );

  return [...saavn, ...fallback];
};

const fetchWithTimeout = (mirror, q, ms = 4000) => {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Timeout: ${mirror.name}`));
    }, ms);

    fetch(mirror.url(q), { signal: controller.signal })
      .then(async (res) => {
        clearTimeout(timer);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const parsed = mirror.parse(await res.json());
        if (parsed?.length > 0) resolve(parsed);
        else reject(new Error(`Empty: ${mirror.name}`));
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
};

app.get("/search", async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: "Missing query" });

  if (CACHE.has(q)) return res.json({ data: CACHE.get(q) });

  try {
    const results = await Promise.any(
      buildActiveMirrors().map((m) => fetchWithTimeout(m, q))
    );

    const seen   = new Set();
    const unique = [];

    for (const s of results) {
      const artist = s.artists?.primary?.[0]?.name ?? "";
      const key    = `${s.name}-${artist}`.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(s);
      }
    }

    const final = unique.slice(0, 50);
    CACHE.set(q, final);
    return res.json({ data: final });
  } catch (err) {
    return res
      .status(502)
      .json({ error: "All music sources unavailable. Try again." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. WEBSOCKET SYNC LOGIC (With Room State Memory)
// ─────────────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
const wss    = new WebSocketServer({ server });
const rooms  = new Map(); // Map<roomCode, { members: Set, state: Object }>

wss.on("connection", (ws) => {
  let joinedRoom = null;
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return; // Ignore malformed messages
    }

    if (data.type === "ping") return;

    const { type, room } = data;

    switch (type) {
      case "join":
        if (joinedRoom && rooms.has(joinedRoom)) {
          const prev = rooms.get(joinedRoom);
          prev.members.delete(ws);
          if (prev.members.size === 0) rooms.delete(joinedRoom);
        }

        if (!rooms.has(room))
          rooms.set(room, { members: new Set(), state: null });

        const roomData = rooms.get(room);
        roomData.members.add(ws);
        joinedRoom = room;

        // Catch-up: send existing song/state to the new member
        if (roomData.state) {
          ws.send(JSON.stringify({ ...roomData.state, serverTime: Date.now() }));
        }

        // Broadcast updated member count
        const msg = JSON.stringify({
          type: "joined",
          room,
          members: roomData.members.size,
        });
        roomData.members.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) client.send(msg);
        });
        break;

      case "play":
      case "pause":
      case "resume":
      case "seek":
        if (joinedRoom && rooms.has(joinedRoom)) {
          const r       = rooms.get(joinedRoom);
          r.state       = data;
          const stamped = JSON.stringify({ ...data, serverTime: Date.now() });
          r.members.forEach((c) => {
            if (c !== ws && c.readyState === WebSocket.OPEN) c.send(stamped);
          });
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
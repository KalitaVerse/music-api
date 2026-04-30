import express from "express";
import fetch from "node-fetch";
import { WebSocketServer, WebSocket } from "ws";

const app = express();
const PORT = process.env.PORT || 3000;

const CACHE = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Fetch with an AbortController timeout. Rejects on timeout or non-200. */
const timedFetch = (url, ms = 5000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { signal: controller.signal })
    .then((res) => { clearTimeout(timer); if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
    .catch((err) => { clearTimeout(timer); throw err; });
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. PRIMARY MIRRORS  (search returns full stream URLs — ready to play)
// ─────────────────────────────────────────────────────────────────────────────
const PRIMARY_MIRRORS = [
  {
    name: "kalita-own",
    fetch: (q) =>
      timedFetch(
        `https://jiosaavn-n0ivatwvc-kalitaverses-projects.vercel.app/api/search/songs?query=${encodeURIComponent(q)}&limit=50`
      ).then((raw) => {
        const r = raw?.data?.results;
        if (!Array.isArray(r) || r.length === 0) throw new Error("Empty");
        return r;
      }),
  },
  {
    name: "jiosaavn-self",
    fetch: (q) =>
      timedFetch(
        `https://jiosaavn-go-brr.mmanojkalita7.workers.dev/api/search/songs?query=${encodeURIComponent(q)}&limit=50`
      ).then((raw) => {
        const r = raw?.data?.results;
        if (!Array.isArray(r) || r.length === 0) throw new Error("Empty");
        return r;
      }),
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 2. FALLBACK MIRRORS  (used only when ALL primaries fail)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * heyjiosaanv — rajput-hemant's API.
 *
 * Search results don't include download URLs, so we do a second parallel
 * fetch for each song:  GET /song?id=SONGID  → gets the stream URLs.
 *
 * All song-detail requests fire in parallel (Promise.allSettled) so the
 * total extra wait is roughly one song-detail RTT, not 50×.
 * Songs whose detail fetch fails keep downloadUrl: [] — they show as cards
 * but can't be played.
 */
const fetchHeyJioSaavn = async (q) => {
  // ── Step 1: search ────────────────────────────────────────────────────
  const raw = await timedFetch(
    `https://heyjiosaanv.vercel.app/search/songs?q=${encodeURIComponent(q)}&limit=50`,
    6000
  );
  const results = raw?.data?.results;
  if (!Array.isArray(results) || results.length === 0) throw new Error("Empty");

  // ── Step 2: fetch song details in parallel to get download URLs ───────
  // Fire all requests at once; allSettled never throws.
  const detailResults = await Promise.allSettled(
    results.map((s) =>
      timedFetch(`https://heyjiosaanv.vercel.app/song?id=${s.id}`, 5000)
    )
  );

  // ── Step 3: merge download URLs into the search results ───────────────
  return results.map((s, i) => {
    // The /song endpoint returns { data: { downloadUrl: [...] } }
    // or { data: [{ downloadUrl: [...] }] } depending on the version.
    let downloadUrl = [];
    if (detailResults[i].status === "fulfilled") {
      const detail = detailResults[i].value;
      // Handle both response shapes
      const songData = Array.isArray(detail?.data)
        ? detail.data[0]
        : detail?.data;
      const raw = songData?.downloadUrl ?? songData?.download_url ?? [];
      downloadUrl = Array.isArray(raw)
        ? raw.map((u) => ({ quality: u.quality, url: u.link ?? u.url ?? "" })).filter((u) => u.url)
        : [];
    }

    return {
      id: s.id,
      name: s.name,
      duration: s.duration?.toString(),
      artists: {
        primary: (s.artist_map?.artists ?? []).map((a) => ({ name: a.name })),
      },
      image: (s.image ?? []).map((img) => ({
        quality: img.quality,
        url: img.link ?? img.url,
      })),
      downloadUrl,
    };
  });
};

const FALLBACK_MIRRORS = [
  { name: "heyjiosaanv", fetch: fetchHeyJioSaavn },
  {
    name: "itunes",
    fetch: (q) =>
      timedFetch(
        `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&limit=20`
      ).then((raw) => {
        if (!Array.isArray(raw?.results)) throw new Error("Empty");
        return raw.results.map((s) => ({
          id: s.trackId?.toString(),
          name: s.trackName,
          artists: { primary: [{ name: s.artistName }] },
          image: [
            { quality: "100x100", url: s.artworkUrl100 },
            { quality: "600x600", url: s.artworkUrl100?.replace("100x100", "600x600") },
          ],
          downloadUrl: [], // preview URL intentionally stripped
          duration: Math.floor((s.trackTimeMillis ?? 0) / 1000).toString(),
          album: { name: s.collectionName },
        }));
      }),
  },
  {
    name: "deezer",
    fetch: (q) =>
      timedFetch(
        `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=20`
      ).then((raw) => {
        if (!Array.isArray(raw?.data)) throw new Error("Empty");
        return raw.data.map((s) => ({
          id: s.id?.toString(),
          name: s.title,
          artists: { primary: [{ name: s.artist?.name }] },
          image: [
            { quality: "small",  url: s.album?.cover_small  },
            { quality: "medium", url: s.album?.cover_medium },
            { quality: "big",    url: s.album?.cover_big    },
          ],
          downloadUrl: [], // preview URL intentionally stripped
          duration: s.duration?.toString(),
          album: { name: s.album?.title },
        }));
      }),
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 2. SEARCH LOGIC
// ─────────────────────────────────────────────────────────────────────────────
const dedupe = (results) => {
  const seen   = new Set();
  const unique = [];
  for (const s of results) {
    const artist = s.artists?.primary?.[0]?.name ?? "";
    const key    = `${s.name}-${artist}`.toLowerCase();
    if (!seen.has(key)) { seen.add(key); unique.push(s); }
  }
  return unique.slice(0, 50);
};

app.get("/search", async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: "Missing query" });

  if (CACHE.has(q)) return res.json({ data: CACHE.get(q) });

  // Shuffle primaries to spread load
  const shuffled = [...PRIMARY_MIRRORS].sort(() => Math.random() - 0.5);

  try {
    let results;

    try {
      // Try primaries first — whichever responds first wins
      results = await Promise.any(shuffled.map((m) => m.fetch(q)));
    } catch {
      // All primaries failed — try fallbacks
      results = await Promise.any(FALLBACK_MIRRORS.map((m) => m.fetch(q)));
    }

    const final = dedupe(results);
    CACHE.set(q, final);
    return res.json({ data: final });
  } catch {
    return res.status(502).json({ error: "All music sources unavailable. Try again." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. WEBSOCKET SYNC LOGIC (With Room State Memory)
// ─────────────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
const wss    = new WebSocketServer({ server });
const rooms  = new Map();

wss.on("connection", (ws) => {
  let joinedRoom = null;
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); }
    catch { return; }

    if (data.type === "ping") return;

    const { type, room } = data;

    switch (type) {
      case "join":
        if (joinedRoom && rooms.has(joinedRoom)) {
          const prev = rooms.get(joinedRoom);
          prev.members.delete(ws);
          if (prev.members.size === 0) rooms.delete(joinedRoom);
        }

        if (!rooms.has(room)) rooms.set(room, { members: new Set(), state: null });

        const roomData = rooms.get(room);
        roomData.members.add(ws);
        joinedRoom = room;

        if (roomData.state) {
          ws.send(JSON.stringify({ ...roomData.state, serverTime: Date.now() }));
        }

        const msg = JSON.stringify({ type: "joined", room, members: roomData.members.size });
        roomData.members.forEach((c) => {
          if (c.readyState === WebSocket.OPEN) c.send(msg);
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
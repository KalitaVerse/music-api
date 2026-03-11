"use strict";
const express = require("express");
const axios   = require("axios");

const app = express();

// ── Mirror registry ───────────────────────────────────────────────────
// All fire in PARALLEL via Promise.any() — fastest success wins.
// Each mirror has its own url builder + response normaliser
// so shape differences are handled per-source.
const MIRRORS = [
  {
    name: "kalita-own",          // YOUR OWN Vercel instance — most reliable
    url: (q) => `https://jiosaavn-n0ivatwvc-kalitaverses-projects.vercel.app/api/search/songs?query=${encodeURIComponent(q)}`,
    parse: (raw) => raw?.data?.results ?? null,
  },
  {
    name: "rajput-hemant",       // jiosaavn-api (TypeScript) by rajput-hemant
    url: (q) => `https://jiosaavn-api-ts.vercel.app/api/search/songs?query=${encodeURIComponent(q)}`,
    parse: (raw) => raw?.data?.results ?? null,
  },
  {
    name: "strtux",              // JioSaavn Unofficial API by StrTux (different shape)
    url: (q) => `https://strtux-main.vercel.app/search/songs?q=${encodeURIComponent(q)}`,
    parse: (raw) => {
      // shape: { status, data: { songs: [...] } }
      // normalise to match sumitkolhe shape so Flutter sees consistent objects
      const songs = raw?.data?.songs ?? null;
      if (!Array.isArray(songs)) return null;
      return songs.map(s => ({
        id:          s.id,
        name:        s.name,
        artists:     { primary: [{ name: s.primaryArtists ?? "Unknown" }] },
        image:       [
                       { quality: "50x50",   url: s.image },
                       { quality: "150x150", url: s.image },
                       { quality: "500x500", url: s.image },
                     ],
        downloadUrl: s.downloadUrl
                       ? [{ quality: "320kbps", url: s.downloadUrl }]
                       : [],
        duration:    s.duration,
        year:        s.year,
      }));
    },
  },
  {
    name: "jiosaavn-api5",       // another sumitkolhe-based public instance
    url: (q) => `https://jiosaavn-api5.vercel.app/api/search/songs?query=${encodeURIComponent(q)}`,
    parse: (raw) => raw?.data?.results ?? null,
  },
  {
    name: "saavn-dev",           // last resort — Cloudflare-blocked on Render IPs
    url: (q) => `https://saavn.dev/api/search/songs?query=${encodeURIComponent(q)}`,
    parse: (raw) => raw?.data?.results ?? null,
  },
];

const GLOBAL_TIMEOUT_MS =  7_000;   // wall-clock cap for the whole race (mirrors respond in <2s warm)
const CACHE             = new Map();
const CACHE_TTL         = 5 * 60 * 1000; // 5 minutes

// ── Cache helpers ─────────────────────────────────────────────────────
function cacheGet(q) {
  const entry = CACHE.get(q);
  if (!entry) return null;
  if (Date.now() > entry.expiry) { CACHE.delete(q); return null; }
  return entry.data;
}
function cacheSet(q, data) {
  CACHE.set(q, { data, expiry: Date.now() + CACHE_TTL });
  if (CACHE.size > 200) CACHE.delete(CACHE.keys().next().value);
}

// saavn.dev stays in MIRRORS for /debug only — excluded from the live race
const ACTIVE_MIRRORS = MIRRORS.slice(0, 4);

// ── Per-mirror fetch ──────────────────────────────────────────────────
async function fetchMirror(mirror, q) {
  const r = await axios.get(mirror.url(q), {
    timeout: GLOBAL_TIMEOUT_MS,
    headers: _headers(),
  });

  const raw = r.data;

  // Reject Cloudflare HTML challenges
  if (typeof raw === "string" && raw.trimStart().startsWith("<")) {
    throw new Error("HTML block (Cloudflare)");
  }

  const results = mirror.parse(raw);

  if (!Array.isArray(results)) {
    throw new Error(`Invalid shape: ${JSON.stringify(raw).slice(0, 80)}`);
  }
  // Allow empty arrays — a genuine "no results" query should not fail the race

  console.log(`[race] ✓ ${mirror.name} → ${results.length} results`);
  return results;
}

// ── Health ────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Music API running", mirrors: MIRRORS.map(m => m.name) });
});

// ── Debug: test ALL mirrors and report ───────────────────────────────
app.get("/debug", async (req, res) => {
  const q = (req.query.q ?? "shape of you").toString().trim();

  const checks = await Promise.allSettled(
    MIRRORS.map(async (m) => {
      const start = Date.now();
      try {
        const results = await fetchMirror(m, q);
        return { name: m.name, ok: true, count: results.length, ms: Date.now() - start };
      } catch (err) {
        return { name: m.name, ok: false, error: err.message, ms: Date.now() - start };
      }
    })
  );

  res.json(checks.map(c => c.value ?? c.reason));
});

// ── Search: race all mirrors, first success wins ──────────────────────
app.get("/search", async (req, res) => {
  const q = (req.query.q ?? "").toString().trim();
  if (!q) return res.status(400).json({ error: "Missing query parameter 'q'" });

  // Cache hit
  const cached = cacheGet(q);
  if (cached) {
    console.log(`[search] cache hit "${q}" (${cached.length} results)`);
    return res.json({ data: cached, cached: true });
  }

  // Race all mirrors — Promise.any() resolves with the FIRST mirror that succeeds
  // Timer ref is stored so we can clear it immediately when the race finishes,
  // preventing the 7s setTimeout from leaking in the Node.js event loop.
  let timeoutHandle;
  const globalTimeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error("Global timeout")), GLOBAL_TIMEOUT_MS);
  });

  try {
    const results = await Promise.any([
      ...ACTIVE_MIRRORS.map(m => fetchMirror(m, q)),
      globalTimeout,
    ]);
    clearTimeout(timeoutHandle); // ← cancel the timer the moment a mirror wins

    // Deduplicate across mirrors (same song can appear from multiple sources)
    const seen   = new Set();
    const unique = [];
    for (const s of results) {
      const artist = s.artists?.primary?.[0]?.name ?? "";
      const key = `${s.name}-${artist}`.toLowerCase();
      if (!seen.has(key)) { seen.add(key); unique.push(s); }
    }
    const final = unique.slice(0, 20);

    cacheSet(q, final);
    return res.json({ data: final });

  } catch (err) {
    clearTimeout(timeoutHandle); // clean up in failure path too
    if (err instanceof AggregateError) {
      // Promise.any rejected — log each mirror's individual reason
      console.error(`[search] All mirrors failed for "${q}". Reasons:`,
        err.errors.map(e => e.message));
    } else {
      console.error(`[search] Unexpected error for "${q}":`, err.message);
    }
    return res.status(502).json({ error: "All search sources failed. Try again in a moment." });
  }
});

// ── Headers ───────────────────────────────────────────────────────────
function _headers() {
  return {
    "User-Agent":    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept":        "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer":       "https://www.jiosaavn.com/",
    "Origin":        "https://www.jiosaavn.com",
  };
}

// ── Start ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Music API running on port ${PORT}`));
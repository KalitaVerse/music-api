"use strict";
const express = require("express");
const axios = require("axios");

const app = express();

// ── Upstream mirrors ──────────────────────────────────────────────────
// saavn.dev is Cloudflare-JS-challenged on Render IPs — blocked permanently.
// These are Vercel-hosted JioSaavn API clones: no Cloudflare, no cold starts.
// Tried in order; first one that returns a non-empty results array wins.
const UPSTREAMS = [
  "https://jiosaavn-n0ivatwvc-kalitaverses-projects.vercel.app/api/search/songs", // YOUR own instance — primary
  "https://saavn.me/api/search/songs",                                             // mirror fallback
  "https://saavn.dev/api/search/songs",                                            // last resort (Cloudflare-blocked on Render)
];

// ── Cache ─────────────────────────────────────────────────────────────
const CACHE     = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function cacheGet(q) {
  const entry = CACHE.get(q);
  if (!entry) return null;
  if (Date.now() > entry.expiry) { CACHE.delete(q); return null; }
  return entry.data;
}

function cacheSet(q, data) {
  CACHE.set(q, { data, expiry: Date.now() + CACHE_TTL });
  // Prevent unbounded growth — evict oldest entry if over 200
  if (CACHE.size > 200) CACHE.delete(CACHE.keys().next().value);
}

// ── Health ────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Music API running" });
});

// ── Debug ─────────────────────────────────────────────────────────────
app.get("/debug", async (req, res) => {
  const q = (req.query.q ?? "shape of you").toString().trim();
  const results = [];

  for (const base of UPSTREAMS) {
    try {
      const r = await axios.get(base, {
        params: { query: q },
        timeout: 10_000,
        headers: _headers(),
      });
      const raw = r.data;
      const isHtml = typeof raw === "string" && raw.trimStart().startsWith("<");
      results.push({
        url: base,
        status: r.status,
        isHtml,
        dataType: typeof raw?.data,
        resultsLength: raw?.data?.results?.length ?? (Array.isArray(raw?.data) ? raw.data.length : "N/A"),
        topKeys: isHtml ? ["(HTML — Cloudflare block)"] : Object.keys(raw ?? {}),
      });
    } catch (err) {
      results.push({
        url: base,
        error: err.message,
        httpStatus: err.response?.status,
      });
    }
  }

  res.json(results);
});

// ── Search ────────────────────────────────────────────────────────────
const GLOBAL_DEADLINE_MS = 15_000; // total wall-clock budget across all mirrors
const PER_MIRROR_MAX_MS  =  8_000; // cap per mirror so one slow host can't eat the budget

app.get("/search", async (req, res) => {
  const q = (req.query.q ?? "").toString().trim();
  if (!q) return res.status(400).json({ error: "Missing query parameter 'q'" });

  // ── Cache hit ────────────────────────────────────────────────────
  const cached = cacheGet(q);
  if (cached) {
    console.log(`[search] cache hit for "${q}" (${cached.length} results)`);
    return res.json({ data: cached, cached: true });
  }

  const deadline = Date.now() + GLOBAL_DEADLINE_MS;

  for (const base of UPSTREAMS) {
    // How many ms remain in the global budget?
    const remaining = deadline - Date.now();
    if (remaining <= 500) {
      console.warn("[search] Global deadline reached, aborting mirror chain");
      break;
    }

    // Per-mirror timeout = whatever is smaller: remaining budget or the per-mirror cap
    const mirrorTimeout = Math.min(remaining, PER_MIRROR_MAX_MS);

    try {
      const r = await axios.get(base, {
        params: { query: q },
        timeout: mirrorTimeout,
        headers: _headers(),
      });

      const raw = r.data;

      // Reject HTML bot-challenge pages (Cloudflare)
      if (typeof raw === "string" && raw.trimStart().startsWith("<")) {
        console.warn(`[search] ${base} → HTML block (Cloudflare), trying next`);
        continue;
      }

      // Normalise every known shape
      const results =
        raw?.data?.results ??
        raw?.data?.data?.results ??
        (Array.isArray(raw?.data) ? raw.data : null) ??
        raw?.results ??
        raw?.songs ??
        null;

      if (!Array.isArray(results)) {
        console.warn(`[search] ${base} → unrecognised shape:`, JSON.stringify(raw).slice(0, 200));
        continue;
      }

      if (results.length === 0) {
        console.warn(`[search] ${base} → empty results, trying next`);
        continue;
      }

      console.log(`[search] ${base} → ${results.length} results for "${q}" ✓`);
      cacheSet(q, results);
      return res.json({ data: results });

    } catch (err) {
      console.warn(`[search] ${base} → error: ${err.message}`);
    }
  }

  console.error(`[search] All upstreams failed for "${q}"`);
  return res.status(502).json({
    error: "All search sources failed. Try again in a moment.",
  });
});

// ── Headers ───────────────────────────────────────────────────────────
function _headers() {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.jiosaavn.com/",
    "Origin": "https://www.jiosaavn.com",
  };
}

// ── Start ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Music API running on port ${PORT}`));
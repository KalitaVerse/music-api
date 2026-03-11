"use strict";
const express = require("express");
const axios = require("axios");

const app = express();

// ── Health / wake-up ─────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Music API running" });
});

// ── Search ───────────────────────────────────────────────────────────
// Flutter client calls: GET /search?q=<query>
app.get("/search", async (req, res) => {
  const q = (req.query.q ?? "").toString().trim();

  if (!q) {
    return res.status(400).json({ error: "Missing query parameter 'q'" });
  }

  const MAX_RETRIES = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const upstream = await axios.get(
        "https://saavn.dev/api/search/songs",
        {
          params: { query: q },
          timeout: 15_000,
          headers: {
            // Mimic a browser — helps avoid bot-blocking
            "User-Agent": "Mozilla/5.0 (compatible; MusicProxy/1.0)",
            "Accept": "application/json",
          },
        }
      );

      // saavn.dev returns: { status, data: { total, start, results: [...] } }
      // Normalise to: { data: [...songs] } so Flutter has a stable contract
      const results =
        upstream.data?.data?.results ??
        upstream.data?.data ??
        upstream.data?.results ??
        [];

      if (!Array.isArray(results)) {
        console.error(`[search] Unexpected shape (attempt ${attempt}):`,
          JSON.stringify(upstream.data).slice(0, 200));
        lastError = new Error("Unexpected upstream response shape");
        continue; // retry
      }

      return res.json({ data: results });

    } catch (err) {
      lastError = err;
      const isRetryable =
        err.code === "ECONNRESET" ||
        err.code === "ECONNABORTED" ||
        err.code === "ETIMEDOUT" ||
        err.message?.includes("socket hang up") ||
        err.message?.includes("timeout");

      console.warn(`[search] Attempt ${attempt}/${MAX_RETRIES} failed:`, err.message);

      if (!isRetryable || attempt === MAX_RETRIES) break;

      // Exponential back-off: 500ms, 1000ms
      await new Promise((r) => setTimeout(r, attempt * 500));
    }
  }

  // All retries exhausted
  const isTimeout =
    lastError?.code === "ECONNABORTED" ||
    lastError?.code === "ETIMEDOUT" ||
    lastError?.message?.includes("timeout");

  console.error("[search] All retries failed:", lastError?.message);
  return res.status(isTimeout ? 504 : 502).json({
    error: isTimeout ? "Upstream timed out" : "Search failed",
    details: lastError?.message,
  });
});

// ── Start ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Music API running on port ${PORT}`);
});
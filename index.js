"use strict";
const express = require("express");
const axios = require("axios");
const https = require("https");

// Reuse TCP connections to saavn.dev
const agent = new https.Agent({ keepAlive: true });

const app = express();

// ── Health / wake-up ─────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Music API running" });
});

// ── Debug: see raw upstream shape ─────────────────────────────────────
// Hit /debug?q=shape+of+you to inspect exactly what saavn.dev returns
app.get("/debug", async (req, res) => {
  const q = (req.query.q ?? "shape of you").toString().trim();
  try {
    const upstream = await axios.get(
      "https://saavn.dev/api/search/songs",
      {
        params: { query: q },
        timeout: 15_000,
        httpsAgent: agent,
        headers: _browserHeaders(),
      }
    );
    // Return full raw response so you can inspect it in the browser
    res.json({
      status: upstream.status,
      keys: Object.keys(upstream.data ?? {}),
      dataType: typeof upstream.data?.data,
      dataKeys: upstream.data?.data ? Object.keys(upstream.data.data) : null,
      resultsLength: upstream.data?.data?.results?.length ?? "N/A",
      raw: upstream.data,
    });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      code: err.code,
      responseStatus: err.response?.status,
      responseData: err.response?.data,
    });
  }
});

// ── Search ───────────────────────────────────────────────────────────
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
          httpsAgent: agent,
          // ── Full browser headers — avoids bot detection on saavn.dev ──
          headers: _browserHeaders(),
        }
      );

      // ── Log the raw shape so Render logs can show us what changed ───
      const raw = upstream.data;
      console.log(
        `[search] upstream shape (attempt ${attempt}):`,
        JSON.stringify({
          topKeys: Object.keys(raw ?? {}),
          dataType: typeof raw?.data,
          dataKeys: raw?.data && typeof raw.data === "object" && !Array.isArray(raw.data)
            ? Object.keys(raw.data)
            : null,
          resultsLength: raw?.data?.results?.length ?? "N/A",
        })
      );

      // ── Normalise: handle every known saavn.dev shape ────────────────
      // Shape A (current): { status, data: { total, start, results: [...] } }
      // Shape B (older):   { data: [...] }
      // Shape C (alt):     { results: [...] }
      // Shape D (nested):  { data: { data: { results: [...] } } }
      let results =
        raw?.data?.results ??           // Shape A ✓
        raw?.data?.data?.results ??     // Shape D ✓
        (Array.isArray(raw?.data) ? raw.data : null) ??   // Shape B ✓
        raw?.results ??                 // Shape C ✓
        raw?.songs ??                   // fallback
        null;

      if (!Array.isArray(results)) {
        console.error(
          `[search] Unrecognised shape (attempt ${attempt}) — full raw:`,
          JSON.stringify(raw).slice(0, 400)
        );
        lastError = new Error("Unexpected upstream response shape");
        continue; // retry
      }

      console.log(`[search] returning ${results.length} result(s) for "${q}"`);
      return res.json({ data: results });

    } catch (err) {
      lastError = err;

      const isRetryable =
        err.code === "ECONNRESET" ||
        err.code === "ECONNABORTED" ||
        err.code === "ETIMEDOUT" ||
        err.message?.includes("socket hang up") ||
        err.message?.includes("timeout");

      console.warn(
        `[search] Attempt ${attempt}/${MAX_RETRIES} failed — code: ${err.code}, msg: ${err.message}`,
        err.response ? `HTTP ${err.response.status}` : ""
      );

      if (!isRetryable || attempt === MAX_RETRIES) break;
      await new Promise((r) => setTimeout(r, attempt * 500));
    }
  }

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

// ── Helpers ───────────────────────────────────────────────────────────
function _browserHeaders() {
  return {
    // Full Chrome UA — critical: "MusicProxy/1.0" is trivially bot-detected
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Referer": "https://www.jiosaavn.com/",
    "Origin": "https://www.jiosaavn.com",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "cross-site",
  };
}

// ── Start ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Music API running on port ${PORT}`);
});
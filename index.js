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

  try {
    const upstream = await axios.get(
      "https://jiosaavn-api-sigma-sandy.vercel.app/api/search/songs",
      {
        params: { query: q },
        timeout: 12_000,
      }
    );

    // saavn.dev returns: { status, data: { total, start, results: [...] } }
    // Normalise to: { data: [...songs] } so the client has a stable contract
    const results =
      upstream.data?.data?.results ??
      upstream.data?.data ??
      upstream.data?.results ??
      [];

    if (!Array.isArray(results)) {
      console.error("[search] Unexpected upstream shape:", JSON.stringify(upstream.data).slice(0, 200));
      return res.status(502).json({ error: "Upstream returned unexpected shape", data: [] });
    }

    return res.json({ data: results });

  } catch (err) {
    // Distinguish timeout vs other errors for better client messages
    const isTimeout = err.code === "ECONNABORTED" || err.message?.includes("timeout");

    console.error("[search] Error:", isTimeout ? "timeout" : err.message);
    return res.status(isTimeout ? 504 : 502).json({
      error: isTimeout ? "Upstream timed out" : "Search failed",
      details: err.message,
    });
  }
});

// ── Start ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Music API running on port ${PORT}`);
});
const express = require("express");
const axios = require("axios");

const app = express();

app.get("/", (req, res) => {
  res.send("Music API running");
});

app.get("/search", async (req, res) => {
  const query = req.query.q;

  if (!query) {
    return res.status(400).json({ error: "Missing query" });
  }

  try {
    const url = `https://saavn.dev/api/search/songs?query=${encodeURIComponent(query)}`;

    const response = await axios.get(url);

    res.json(response.data);
  } catch (err) {
    console.error("Search error:", err.response?.data || err.message);

    res.status(500).json({
      error: "Search failed",
      details: err.response?.data || err.message
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Music API running on port ${PORT}`);
});
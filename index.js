const express = require("express");
const fetch = require("node-fetch");

const app = express();

const PORT = process.env.PORT || 3000;

app.get("/search", async (req, res) => {
  const query = req.query.q;

  if (!query) {
    return res.json({ error: "Missing query" });
  }

  try {
    const response = await fetch(
      "https://saavn.dev/api/search/songs?query=" + encodeURIComponent(query)
    );

    const data = await response.json();

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Search failed" });
  }
});

app.listen(PORT, () => {
  console.log("Music API running on port " + PORT);
});

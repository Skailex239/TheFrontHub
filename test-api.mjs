// Quick single-page test
const PUBLIC_ID = "UWetOwlW";
const url = `https://api.openfront.io/public/player/${PUBLIC_ID}/games`;

(async () => {
  console.log("Fetching:", url);
  const start = Date.now();
  try {
    const r = await fetch(url, { headers: { "User-Agent": "TheFrontHub-Verify/1.0" } });
    console.log("Status:", r.status, "in", Date.now() - start, "ms");
    if (r.ok) {
      const data = await r.json();
      console.log("Results:", data.results?.length || 0);
      console.log("nextCursor:", data.nextCursor ? "yes" : "no");
      if (data.results?.[0]) {
        console.log("Sample game:", JSON.stringify(data.results[0], null, 2));
      }
    } else {
      console.log("Body:", await r.text());
    }
  } catch (e) {
    console.error("Error:", e.message);
  }
})();

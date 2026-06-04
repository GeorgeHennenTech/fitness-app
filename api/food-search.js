// Vercel serverless endpoint: proxy Open Food Facts text search AND barcode
// lookups. OFF doesn't return CORS headers, so direct browser fetches fail
// with "load failed". This endpoint runs server-side and returns raw OFF JSON.
//
// Mount path: /api/food-search
// Two modes:
//   GET /api/food-search?query=<text>       → text search, returns OFF /cgi/search.pl JSON
//   GET /api/food-search?barcode=<code>     → product lookup, returns OFF /api/v2/product JSON

export default async function handler(req, res) {
  const query = (req.query?.query || '').toString().trim();
  const barcode = (req.query?.barcode || '').toString().trim();

  if (!query && !barcode) {
    return res.status(400).json({ error: 'query or barcode parameter required' });
  }

  let url;
  if (barcode) {
    // Strip everything that isn't a digit — OFF barcode endpoints want digits only
    const cleanBarcode = barcode.replace(/\D/g, '');
    if (!cleanBarcode || cleanBarcode.length < 6 || cleanBarcode.length > 20) {
      return res.status(400).json({ error: 'invalid barcode format' });
    }
    url = `https://world.openfoodfacts.org/api/v2/product/${cleanBarcode}.json`;
  } else {
    if (query.length > 200) {
      return res.status(400).json({ error: 'query too long' });
    }
    url =
      'https://world.openfoodfacts.org/cgi/search.pl?' +
      'search_terms=' + encodeURIComponent(query) +
      '&search_simple=1&action=process&json=1&page_size=20';
  }

  try {
    const offResponse = await fetch(url, {
      headers: {
        // OFF asks API consumers to identify themselves. Adjust contact as needed.
        'User-Agent': 'seth-fitness-tracker/1.0 (personal use)',
        'Accept': 'application/json',
      },
    });

    if (!offResponse.ok) {
      return res.status(offResponse.status).json({
        error: `Open Food Facts returned ${offResponse.status}`,
      });
    }

    const data = await offResponse.json();
    // Light cache so repeated identical lookups don't hammer OFF
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=86400');
    return res.status(200).json(data);
  } catch (e) {
    return res.status(502).json({ error: e?.message || 'fetch failed' });
  }
}

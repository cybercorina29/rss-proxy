const MAX_BYTES = 3 * 1024 * 1024;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function validate(raw) {
  const url = new URL(raw);
  const hosts = (process.env.ALLOWED_RSS_HOSTS || 'news.google.com,feeds.bbci.co.uk,api.gdeltproject.org')
    .split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
  if (url.protocol !== 'https:' || url.username || url.password ||
      (url.port && url.port !== '443') || !hosts.includes(url.hostname.toLowerCase())) {
    throw new Error('Only HTTPS URLs on allowed RSS hosts are supported.');
  }
  return url;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'Use GET.' });
  }
  // URLSearchParams decodes the query once, preserving encoded characters in the feed URL.
  const raw = new URL(req.url, 'https://proxy.local').searchParams.get('url');
  let target;
  try {
    if (!raw) throw new Error('Missing url query parameter.');
    target = validate(raw);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    let upstream;
    for (let hop = 0; hop <= 3; hop++) {
      upstream = await fetch(target, {
        signal: controller.signal,
        redirect: 'manual',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, application/json;q=0.9, */*;q=0.8'
        }
      });
      if (!REDIRECTS.has(upstream.status)) break;
      const location = upstream.headers.get('location');
      await upstream.body?.cancel();
      if (!location || hop === 3) throw new Error('Invalid or excessive upstream redirects.');
      target = validate(new URL(location, target).href);
    }
    const chunks = [];
    let size = 0;
    if (upstream.body) {
      for await (const chunk of upstream.body) {
        size += chunk.length;
        if (size > MAX_BYTES) throw new Error('Upstream response exceeds 3 MB.');
        chunks.push(Buffer.from(chunk));
      }
    }
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
    const retryAfter = upstream.headers.get('retry-after');
    if (retryAfter) res.setHeader('Retry-After', retryAfter);
    if (upstream.status === 200) {
      res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=300, stale-while-revalidate=600');
    }
    return res.status(upstream.status).send(Buffer.concat(chunks));
  } catch (error) {
    return res.status(controller.signal.aborted ? 504 : 502).json({
      error: controller.signal.aborted ? 'RSS source timed out after 20 seconds.' : error.message
    });
  } finally {
    clearTimeout(timer);
  }
};

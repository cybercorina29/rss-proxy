const { lookup } = require('node:dns/promises');
const { isIP } = require('node:net');
const MAX_BYTES = 3 * 1024 * 1024;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function publicAddress(address) {
  const ip = address.toLowerCase();
  if (isIP(ip) === 4) {
    const p = ip.split('.').map(Number);
    return !(p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224 ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && (p[1] === 168 || (p[1] === 0 && (p[2] === 0 || p[2] === 2)))) ||
      (p[0] === 198 && (p[1] === 18 || p[1] === 19 || (p[1] === 51 && p[2] === 100))) ||
      (p[0] === 203 && p[1] === 0 && p[2] === 113));
  }
  if (isIP(ip) === 6) {
    if (ip.startsWith('::ffff:')) {
      const embedded = ip.slice(7);
      if (isIP(embedded) === 4) return publicAddress(embedded);
      if (/^[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(embedded)) {
        const [a, b] = embedded.split(':').map(x => parseInt(x, 16));
        return publicAddress([a >> 8, a & 255, b >> 8, b & 255].join('.'));
      }
    }
    return !(ip === '::' || ip === '::1' || ip.startsWith('fc') ||
      ip.startsWith('fd') || /^fe[89ab]/.test(ip) || ip.startsWith('2001:db8:'));
  }
  return false;
}

async function validate(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password ||
      (url.port && url.port !== '443')) {
    throw new Error('Only standard HTTPS URLs without credentials are supported.');
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.') || host === 'localhost' || host.endsWith('.localhost') ||
      host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Local and internal hosts are not supported.');
  }
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) {
    throw new Error('Only public internet hosts are supported.');
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
    target = await validate(raw);
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
      target = await validate(new URL(location, target).href);
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

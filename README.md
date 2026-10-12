# RSS proxy

Vercel Node.js function for adverse-media RSS monitoring.

## Deploy

Import this repository at https://vercel.com/new. Choose framework preset **Other**, leave build and output overrides unset, and deploy. Copy the actual production domain shown by Vercel.

Endpoint: `https://YOUR-DOMAIN/api/proxy?url=ENCODED_FEED_URL`

## Apps Script

```javascript
const proxyBase = 'https://YOUR-DOMAIN/api/proxy';
const feedUrl = 'https://news.google.com/rss/search?q=' +
  encodeURIComponent('"Company Name"') + '&hl=en-GB&gl=GB&ceid=GB:en';
const response = UrlFetchApp.fetch(
  proxyBase + '?url=' + encodeURIComponent(feedUrl),
  { muteHttpExceptions: true }
);
if (response.getResponseCode() !== 200) {
  throw new Error('RSS proxy HTTP ' + response.getResponseCode() + ': ' +
    response.getContentText().slice(0, 300));
}
const xml = XmlService.parse(response.getContentText());
```

## Behaviour

- GET and CORS OPTIONS supported.
- Browser-style User-Agent and RSS/XML/JSON Accept headers.
- Raw response bytes, upstream status and Content-Type preserved.
- 20-second total upstream timeout; Vercel function duration 30 seconds.
- Successful responses cached at the CDN for 5 minutes, with a further 10-minute stale-while-revalidate window.
- Responses capped at 3 MB.
- HTTPS requests restricted to news.google.com, feeds.bbci.co.uk and api.gdeltproject.org. Every redirect is checked, with at most three redirects.
- To add trusted RSS sources, set Vercel environment variable ALLOWED_RSS_HOSTS to a comma-separated list of exact hostnames. This replaces the defaults; redeploy after changing it.

A proxy changes the requesting infrastructure but cannot guarantee that a source will stop rate-limiting or blocking requests. CORS is for browser clients; Apps Script does not need it. The endpoint is public, so avoid confidential search terms. Upstream errors are not cached.

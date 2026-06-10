// Returns a one-time Cloudflare Stream upload URL so the browser can upload the video
// directly to Cloudflare (keeps the API token server-side). Dormant until CF env vars are set.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const acct = process.env.CF_ACCOUNT_ID;
  const token = process.env.CF_STREAM_TOKEN;
  if (!acct || !token) return res.status(200).json({ enabled: false });

  try {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/stream/direct_upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxDurationSeconds: 130, requireSignedURLs: false })
    });
    const d = await r.json();
    if (!d.success) return res.status(502).json({ enabled: true, error: d.errors });
    res.status(200).json({ enabled: true, uploadURL: d.result.uploadURL, uid: d.result.uid });
  } catch (e) {
    res.status(500).json({ enabled: true, error: e.message });
  }
}

// Inline AI content moderation. Receives a few frames from the video and checks them
// with Sightengine's nudity model. Swimwear/bikini/suggestive = allowed; explicit = blocked.
// If no Sightengine keys are set, it allows everything (so the app still works pre-setup).

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = process.env.SIGHTENGINE_USER;
  const secret = process.env.SIGHTENGINE_SECRET;
  if (!user || !secret) return res.status(200).json({ allow: true, skipped: true });

  try {
    const { frames = [] } = req.body || {};
    let worst = 0;

    for (const f of frames.slice(0, 3)) {
      const b64 = (f || '').split(',')[1];
      if (!b64) continue;
      const buf = Buffer.from(b64, 'base64');

      const form = new FormData();
      form.append('media', new Blob([buf], { type: 'image/jpeg' }), 'frame.jpg');
      form.append('models', 'nudity-2.1');
      form.append('api_user', user);
      form.append('api_secret', secret);

      const r = await fetch('https://api.sightengine.com/1.0/check.json', { method: 'POST', body: form });
      const j = await r.json();
      const n = j.nudity || {};
      // Explicit categories we block. (very_suggestive = bikini/swimwear -> NOT counted.)
      const explicit = (n.sexual_activity || 0) + (n.sexual_display || 0) + (n.erotica || 0);
      if (explicit > worst) worst = explicit;
    }

    if (worst > 0.5) {
      return res.status(200).json({
        allow: false,
        score: worst,
        reason: "This video looks like it contains explicit content, which isn't allowed. Swimwear and bikini content is fine — full nudity and sexual content are not."
      });
    }
    return res.status(200).json({ allow: true, score: worst });
  } catch (e) {
    // On any failure, don't hard-block the creator — allow but flag for later review.
    return res.status(200).json({ allow: true, skipped: true, error: e.message });
  }
}

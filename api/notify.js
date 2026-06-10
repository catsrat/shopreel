// Sends a web-push notification to a target user. Called by the client after a
// like/follow/comment. The caller is verified via their Supabase token.
import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@shopreel.app', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.VAPID_PRIVATE_KEY) return res.status(200).json({ ok: false, reason: 'push not configured' });

  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  const { data: { user } = {}, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'unauthorized' });

  const { toUserId, body } = req.body || {};
  if (!toUserId || !body) return res.status(400).json({ error: 'bad request' });
  if (toUserId === user.id) return res.status(200).json({ ok: true, skipped: 'self' });

  const { data: subs } = await supabase.from('push_subscriptions').select('*').eq('user_id', toUserId);
  const payload = JSON.stringify({ title: 'ShopReel', body: String(body).slice(0, 140), url: './' });
  let sent = 0;
  for (const s of (subs || [])) {
    try { await webpush.sendNotification(s.subscription, payload); sent++; }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) await supabase.from('push_subscriptions').delete().eq('endpoint', s.endpoint); }
  }
  res.status(200).json({ ok: true, sent });
}

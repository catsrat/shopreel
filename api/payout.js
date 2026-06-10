// Owner-only payouts API.
//  GET            -> list every creator with their payable balance + payout method
//  POST {creator_id} -> pay one creator
//  POST {all:true}   -> pay everyone with a positive balance
// Auth: the owner's Supabase session token; the server checks the email == OWNER_EMAIL.
// Money moves via PayPal Payouts — SANDBOX by default; dormant until PayPal creds are set.
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const PP_BASE = (process.env.PAYPAL_ENV === 'live') ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

async function requireOwner(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  if (!process.env.OWNER_EMAIL || data.user.email !== process.env.OWNER_EMAIL) return null;
  return data.user;
}

async function paypalToken() {
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`).toString('base64');
  const r = await fetch(`${PP_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  if (!r.ok) throw new Error('PayPal auth failed');
  return (await r.json()).access_token;
}

async function payOne(creator_id) {
  const { data: earn } = await supabase.from('creator_earnings').select('*').eq('creator_id', creator_id).maybeSingle();
  const { data: acct } = await supabase.from('payout_accounts').select('*').eq('user_id', creator_id).maybeSingle();
  const confirmed = Number(earn?.confirmed) || 0, paid = Number(earn?.paid_out) || 0;
  const payable = +(confirmed - paid).toFixed(2);
  const currency = earn?.currency || 'EUR';
  if (payable <= 0) return { creator_id, ok: false, reason: 'nothing payable' };
  if (!acct?.paypal_email) return { creator_id, ok: false, reason: 'no PayPal email' };
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_SECRET) return { creator_id, ok: false, reason: 'PayPal not configured' };

  const token = await paypalToken();
  const r = await fetch(`${PP_BASE}/v1/payments/payouts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender_batch_header: { sender_batch_id: `sr_${creator_id}_${Date.now()}`, email_subject: 'Your ShopReel earnings' },
      items: [{ recipient_type: 'EMAIL', amount: { value: payable.toFixed(2), currency }, receiver: acct.paypal_email, note: 'ShopReel creator earnings', sender_item_id: `${creator_id}_${Date.now()}` }]
    })
  });
  const body = await r.json();
  if (!r.ok) return { creator_id, ok: false, reason: 'paypal error', detail: body };
  await supabase.from('creator_earnings').update({ paid_out: paid + payable, updated_at: new Date().toISOString() }).eq('creator_id', creator_id);
  return { creator_id, ok: true, paid: payable, currency, to: acct.paypal_email };
}

export default async function handler(req, res) {
  const owner = await requireOwner(req);
  if (!owner) return res.status(401).json({ error: 'unauthorized' });

  if (req.method === 'GET') {
    const { data: earns } = await supabase.from('creator_earnings').select('*');
    const { data: accts } = await supabase.from('payout_accounts').select('*');
    const { data: profs } = await supabase.from('profiles').select('id, handle');
    const acctMap = Object.fromEntries((accts || []).map(a => [a.user_id, a]));
    const profMap = Object.fromEntries((profs || []).map(p => [p.id, p.handle]));
    const creators = (earns || []).map(e => ({
      creator_id: e.creator_id,
      handle: profMap[e.creator_id] || '?',
      payable: Math.max(0, (Number(e.confirmed) || 0) - (Number(e.paid_out) || 0)),
      confirmed: Number(e.confirmed) || 0,
      paid_out: Number(e.paid_out) || 0,
      paypal: acctMap[e.creator_id]?.paypal_email || '',
      currency: e.currency || 'EUR'
    })).sort((a, b) => b.payable - a.payable);
    return res.json({ ok: true, creators });
  }

  if (req.method === 'POST') {
    const { creator_id, all } = req.body || {};
    if (all) {
      const { data: earns } = await supabase.from('creator_earnings').select('creator_id, confirmed, paid_out');
      const toPay = (earns || []).filter(e => ((Number(e.confirmed) || 0) - (Number(e.paid_out) || 0)) > 0);
      const results = [];
      for (const e of toPay) results.push(await payOne(e.creator_id));
      return res.json({ ok: true, results });
    }
    if (creator_id) return res.json(await payOne(creator_id));
    return res.status(400).json({ error: 'creator_id or all required' });
  }
  res.status(405).json({ error: 'method not allowed' });
}

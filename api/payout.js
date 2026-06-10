// Pay a single creator their available balance (confirmed − already paid) via PayPal Payouts.
// Owner-triggered (protected by PAYOUT_SECRET). Defaults to PayPal SANDBOX so no real money
// moves until you set PAYPAL_ENV=live. Dormant until PayPal credentials are configured.
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const PP_BASE = (process.env.PAYPAL_ENV === 'live')
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

async function paypalToken() {
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`).toString('base64');
  const r = await fetch(`${PP_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  if (!r.ok) throw new Error('PayPal auth failed: ' + (await r.text()).slice(0, 200));
  return (await r.json()).access_token;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (req.headers.authorization !== `Bearer ${process.env.PAYOUT_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_SECRET) {
    return res.status(200).json({ ok: false, reason: 'PayPal not configured yet' });
  }

  try {
    const { creator_id } = req.body || {};
    if (!creator_id) return res.status(400).json({ error: 'creator_id required' });

    const { data: earn } = await supabase.from('creator_earnings').select('*').eq('creator_id', creator_id).maybeSingle();
    const { data: acct } = await supabase.from('payout_accounts').select('*').eq('user_id', creator_id).maybeSingle();
    const confirmed = Number(earn?.confirmed) || 0;
    const paid = Number(earn?.paid_out) || 0;
    const payable = +(confirmed - paid).toFixed(2);
    const currency = earn?.currency || 'EUR';

    if (payable <= 0) return res.status(200).json({ ok: false, reason: 'nothing payable', payable });
    if (!acct?.paypal_email) return res.status(200).json({ ok: false, reason: 'creator has no PayPal email' });

    const token = await paypalToken();
    const batchId = `shopreel_${creator_id}_${Date.now()}`;
    const r = await fetch(`${PP_BASE}/v1/payments/payouts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender_batch_header: { sender_batch_id: batchId, email_subject: 'Your ShopReel earnings', email_message: 'Thanks for creating on ShopReel!' },
        items: [{
          recipient_type: 'EMAIL',
          amount: { value: payable.toFixed(2), currency },
          receiver: acct.paypal_email,
          note: 'ShopReel creator earnings',
          sender_item_id: `${creator_id}_${Date.now()}`
        }]
      })
    });
    const body = await r.json();
    if (!r.ok) return res.status(502).json({ ok: false, reason: 'paypal error', detail: body });

    // mark as paid so we don't double-pay
    await supabase.from('creator_earnings').update({ paid_out: paid + payable, updated_at: new Date().toISOString() }).eq('creator_id', creator_id);

    res.json({ ok: true, paid: payable, currency, to: acct.paypal_email, batch: body?.batch_header?.payout_batch_id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

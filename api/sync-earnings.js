// Scheduled sync: pulls per-creator earnings from Sovrn's CUIDs report and writes them
// into creator_earnings (keyed by creator_id, which we send as the cuid on every Shop click).
// Runs on a Vercel Cron (see vercel.json). Secrets come from Vercel env vars.
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const ymd = (d) => d.toISOString().slice(0, 10);
const num = (...vals) => { for (const v of vals) if (v != null && !isNaN(Number(v))) return Number(v); return 0; };

export default async function handler(req, res) {
  // protect the endpoint (Vercel Cron sends this automatically when CRON_SECRET is set)
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const key = process.env.SOVRN_API_SECRET;
  if (!key) return res.status(500).json({ error: 'SOVRN_API_SECRET not set' });

  const end = new Date();
  const start = new Date(Date.now() - 30 * 864e5);   // last 30 days (API max range is 31)
  const url = `https://viglink.io/v1/reports/cuids?clickDateStart=${ymd(start)}&clickDateEnd=${ymd(end)}`;

  let rows;
  try {
    const r = await fetch(url, { headers: { Authorization: `secret ${key}`, Accept: 'application/json' } });
    if (!r.ok) { const t = await r.text(); return res.status(502).json({ error: 'sovrn', status: r.status, body: t.slice(0, 300) }); }
    const data = await r.json();
    rows = Array.isArray(data) ? data : (data.data || data.results || data.rows || data.report || []);
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }

  let updated = 0;
  for (const row of rows) {
    const cuid = row.cuid || row.cuId || row.CUID || row.customId;
    if (!cuid || !/^[0-9a-f-]{36}$/i.test(cuid)) continue;   // only our creator UUIDs
    const revenue = num(row.revenue, row.publisherNetRevenue, row.earnings, row.netRevenue);
    const clicks = num(row.clicks, row.clickCount, row.clicksCount);
    const sales = num(row.sales, row.salesCount, row.orders, row.actions);
    const { error } = await supabase.from('creator_earnings').upsert({
      creator_id: cuid,
      clicks, sales,
      confirmed: revenue,
      currency: row.currency || 'EUR',
      updated_at: new Date().toISOString()
    }, { onConflict: 'creator_id' });
    if (!error) updated++;
  }

  res.json({ ok: true, rowsFromSovrn: rows.length, creatorsUpdated: updated });
}

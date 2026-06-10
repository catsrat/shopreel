// Stripe webhook — Stripe calls this after a payment to confirm the subscription.
// It marks the user's plan in the database. Secrets come from Vercel env vars.
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// We need the raw request body to verify Stripe's signature.
export const config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  let event;
  try {
    const raw = await readRawBody(req);
    event = stripe.webhooks.constructEvent(raw, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      const userId = s.client_reference_id || s.metadata?.userId;
      const plan = s.metadata?.plan;
      if (userId) {
        await supabase.from('profiles').update({
          plan,
          plan_since: new Date().toISOString(),
          stripe_customer_id: s.customer
        }).eq('id', userId);
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      await supabase.from('profiles').update({ plan: null }).eq('stripe_customer_id', sub.customer);
    }
  } catch (e) {
    // log but still acknowledge so Stripe doesn't keep retrying
    console.error('webhook handler error', e);
  }

  res.json({ received: true });
}

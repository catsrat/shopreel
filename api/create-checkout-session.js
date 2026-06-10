// Creates a Stripe Checkout session for a subscription plan.
// Called by the app when a creator picks a plan. Returns a URL to redirect to.
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PRICE_IDS = {
  starter:  process.env.STRIPE_PRICE_STARTER,   // €10/mo price id
  pro:      process.env.STRIPE_PRICE_PRO,        // €25/mo price id
  business: process.env.STRIPE_PRICE_BUSINESS    // €49/mo price id
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { plan, userId, email } = req.body || {};
    const price = PRICE_IDS[plan];
    if (!price) return res.status(400).json({ error: 'Unknown plan' });

    const origin = req.headers.origin || `https://${req.headers.host}`;
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price, quantity: 1 }],
      customer_email: email || undefined,
      client_reference_id: userId,
      metadata: { userId: userId || '', plan },
      success_url: `${origin}/?sub=success`,
      cancel_url: `${origin}/?sub=cancel`,
      allow_promotion_codes: true
    });
    res.status(200).json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

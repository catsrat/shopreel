# ShopReel — Going Real: Setup Guide

This turns the demo into a real, multi-user app with payments. You create the accounts; Claude writes all the code. Follow the steps in order. **~45–60 min of clicking, no coding.**

There are 3 services: **Supabase** (accounts + database + video storage), **Stripe** (payments), **Vercel** (hosting).

---

## ⚠️ Golden rule about keys

Some keys are **public** (safe to paste back to Claude in chat). Some are **secret** (never paste in chat — put them straight into Vercel).

| ✅ Safe to send Claude | 🔒 Secret — Vercel only, never in chat |
|---|---|
| Supabase Project URL | Supabase `service_role` key |
| Supabase `anon` public key | Stripe **Secret** key (`sk_...`) |
| Stripe **Publishable** key (`pk_...`) | Stripe Webhook signing secret (`whsec_...`) |
| Stripe Price IDs (`price_...`) | |

---

## STEP 1 — Supabase (database + login + video storage) · free

1. Go to **https://supabase.com** → sign up → **New project**. Pick a name + a strong DB password (save it). Wait ~2 min for it to build.
2. Left menu → **SQL Editor** → **New query**. Open the file `supabase/schema.sql` from this folder, copy ALL of it, paste, click **Run**. (Creates the tables.)
3. Left menu → **Storage** → **New bucket** → name it exactly `videos` → toggle **Public** ON → create.
4. Left menu → **Authentication → Providers** → make sure **Email** is enabled. (Google login is optional/later.)
5. Left menu → **Project Settings → API**. Copy these two:
   - **Project URL**  → send to Claude
   - **anon public** key → send to Claude
   - **service_role** key → 🔒 save for Vercel (Step 3), do NOT paste in chat.

---

## STEP 2 — Stripe (payments) · free to set up

1. Go to **https://stripe.com** → create account. (To take real money you'll later complete business/bank verification; you can build in **test mode** first.)
2. **Products** → **Add product**, create three, each a **recurring / monthly** price:
   - `ShopReel Starter` — **€10 / month**
   - `ShopReel Pro` — **€25 / month**
   - `ShopReel Business` — **€49 / month**
3. Open each product and copy its **Price ID** (looks like `price_1Abc...`). → send all three to Claude (tell me which is which).
4. **Developers → API keys**:
   - **Publishable key** (`pk_...`) → send to Claude
   - **Secret key** (`sk_...`) → 🔒 save for Vercel.
5. The **Webhook** signing secret comes after deploy — see Step 3.6.

---

## STEP 3 — Vercel (put it online) · free

1. Go to **https://vercel.com** → sign up (use GitHub or email).
2. **Add New → Project**. Easiest no-GitHub route: install the Vercel CLI later, or drag-and-drop deploy. (Claude will give exact commands when your keys are in.)
3. Before/After first deploy, add **Environment Variables** (Project → Settings → Environment Variables). Add these 🔒 secrets:
   - `SUPABASE_URL` = your Supabase Project URL
   - `SUPABASE_SERVICE_KEY` = Supabase service_role key
   - `STRIPE_SECRET_KEY` = Stripe secret key (`sk_...`)
   - `STRIPE_PRICE_STARTER` = the €10 price id
   - `STRIPE_PRICE_PRO` = the €25 price id
   - `STRIPE_PRICE_BUSINESS` = the €49 price id
   - `STRIPE_WEBHOOK_SECRET` = (fill in after step 6)
4. Deploy. You get a live URL like `shopreel.vercel.app`.
5. **Stripe webhook:** in Stripe → **Developers → Webhooks → Add endpoint**:
   - URL: `https://YOUR-VERCEL-URL/api/stripe-webhook`
   - Events: `checkout.session.completed` and `customer.subscription.deleted`
6. Stripe shows a **Signing secret** (`whsec_...`). Put it in Vercel as `STRIPE_WEBHOOK_SECRET`, then redeploy.

---

## What to send Claude (paste in chat — public keys only)

```
Supabase URL:           https://xxxx.supabase.co
Supabase anon key:      eyJ...
Stripe publishable key: pk_test_... (or pk_live_...)
Price IDs:              starter=price_...  pro=price_...  business=price_...
```

🔒 Keep these OUT of chat — put them in Vercel only:
`service_role` key, Stripe `sk_...`, `whsec_...`.

---

## Then what?

Once you send the public keys above, Claude will:
1. Paste them into `config.js`,
2. Convert the app from local-demo storage to the **real Supabase backend** (real signup, shared feed, cloud video uploads),
3. Wire the **➕ subscription** buttons to real Stripe checkout,
4. Give you the exact deploy command.

**Fastest unblock:** do STEP 1 first and send me the Supabase **URL + anon key** — that alone lets me convert the whole app to a real backend while you work on Stripe.

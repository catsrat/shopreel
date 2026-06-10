# Enable "Continue with Google" (Gmail login)

The button is already in the app. Google requires a one-time registration. ~15 min, no coding.

---

## STEP A — Get Supabase's callback URL (you'll need it in a sec)

Your callback URL is:
```
https://bljqdxluydjpmvdnnxtk.supabase.co/auth/v1/callback
```

---

## STEP B — Create Google OAuth credentials

1. Go to **https://console.cloud.google.com** → sign in with your Gmail.
2. Top bar → **Select a project → New Project** → name it `ShopReel` → create → select it.
3. Left menu → **APIs & Services → OAuth consent screen**:
   - User type: **External** → Create.
   - App name: `ShopReel`, user support email: your email, developer email: your email → Save and continue through the steps (you can skip scopes). 
   - While in **Testing** mode, add your own Gmail under **Test users** so you can log in.
4. Left menu → **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Web application**.
   - Name: `ShopReel Web`.
   - **Authorized JavaScript origins**, add:
     - `http://localhost:8123`
     - (later) your live URL, e.g. `https://shopreel.vercel.app`
   - **Authorized redirect URIs**, add the Supabase callback from Step A:
     - `https://bljqdxluydjpmvdnnxtk.supabase.co/auth/v1/callback`
   - Create. Google shows a **Client ID** and **Client Secret** — copy both.

---

## STEP C — Put them into Supabase

1. Supabase dashboard → **Authentication → Sign In / Providers → Google** → enable.
2. Paste the **Client ID** and **Client Secret** from Step B → Save.
   - 🔒 The Client Secret goes here in Supabase only — not in chat, not in the frontend.

---

## STEP D — Tell Supabase which URLs are allowed

Supabase dashboard → **Authentication → URL Configuration**:
- **Site URL:** `http://localhost:8123` (change to your live URL after deploy)
- **Redirect URLs:** add `http://localhost:8123` and (later) your live URL.

---

## Done — test it

Refresh the app → click **Continue with Google** → pick your Gmail → you're logged in.
Your handle is auto-set from your email (e.g. `you` from `you@gmail.com`); change it anytime in **⚙️ Settings**.

> Note: while the Google consent screen is in **Testing**, only emails you added as **Test users** can log in. To open it to everyone you later click **Publish app** on the OAuth consent screen (Google may ask for a quick review if you request sensitive scopes — we don't, so it's usually instant).

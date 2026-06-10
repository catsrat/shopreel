# ShopReel — App (PWA)

A real, installable app that works on iPhone & Android via the browser — no app store needed yet. This is your MVP for getting creators using the product and giving feedback.

---

## Run it on your computer

A PWA must be served over a web address (not double-clicked). From this folder, run:

```
python3 -m http.server 8123
```

Then open **http://localhost:8123** in your browser.

(Stop the server later with Ctrl+C in that terminal.)

---

## What works today

- **Creator login** (name + email + your space: beauty / fashion / fitness / home)
- **Shoppable video feed** — full-screen videos with tappable product cards
- **Create a post** — upload a video (or paste a video URL) + add affiliate products
- **Tap-to-shop** — product taps open the affiliate link and are counted
- **Dashboard** — your videos and how many product taps each got
- **Installable** — "Add to Home Screen" makes it behave like a native app

> Data is stored **on the device** for now (so it's perfect for demos and feedback).
> The next build swaps this for a real backend: Google login, cloud video hosting, cross-device sync, and subscription billing.

---

## Put it online (free) so creators can try it on their phones

1. Sign up at **https://vercel.com** (free, use Google).
2. **Add New → Project → deploy/drag-and-drop**, drag this `shopreel-app` folder in.
3. You get a live link like `shopreel-app.vercel.app`.
4. On a phone: open that link → browser menu → **"Add to Home Screen"** → it installs like an app.

---

## Test "Add to Home Screen"

- **iPhone (Safari):** Share button → *Add to Home Screen*.
- **Android (Chrome):** menu (⋮) → *Install app* / *Add to Home Screen*.

---

## What's NOT real yet (on purpose — comes after validation)

- Real Google sign-in (currently a simple name/email)
- Cloud video hosting (uploads live in the browser for now)
- Cross-device accounts & feed
- Subscription billing (Stripe)
- AI product tagging / auto-clips

We build those once creators confirm they want this. Then this same app converts to native iOS + Play Store apps with Expo/React Native.

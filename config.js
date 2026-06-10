// ShopReel public config — these keys are safe to expose in the browser.
// Secret keys (Stripe secret, Supabase service_role, webhook secret) do NOT go here —
// they go into Vercel Environment Variables only.
window.SHOPREEL_CONFIG = {
  SUPABASE_URL: "https://bljqdxluydjpmvdnnxtk.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJsanFkeGx1eWRqcG12ZG5ueHRrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwMjk2NDYsImV4cCI6MjA5NjYwNTY0Nn0.l1diIeFpHT0tlMtuHZ1qFbGx-y-DN10s_ZuBGP3R4bY",
  STRIPE_PUBLISHABLE_KEY: "PASTE_STRIPE_PUBLISHABLE_KEY",

  // Affiliate commission tracking (fill in once you have a Sovrn/Skimlinks account).
  // Paste your aggregator's redirect template using {URL} and {SUBID} placeholders.
  //   Skimlinks example: "https://go.skimresources.com/?id=YOURID&xs=1&url={URL}&xcust={SUBID}"
  // Leave empty to disable (Shop links just open normally, no commission tracking yet).
  AFFILIATE_TEMPLATE: "https://redirect.viglink.com/?format=go&key=652073351dbf60cf1dc9dd04ecab8ee7&u={URL}&cuid={SUBID}"
};

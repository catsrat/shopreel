/* ShopReel — real backend (Supabase + Stripe).
   Auth, profiles, posts, products, video storage and stats all live in Supabase.
   Subscriptions go through Stripe Checkout once deployed (falls back to demo locally). */

'use strict';

const CFG = window.SHOPREEL_CONFIG;
const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
const STRIPE_READY = CFG.STRIPE_PUBLISHABLE_KEY && !/^PASTE/.test(CFG.STRIPE_PUBLISHABLE_KEY);

// Wrap a product link with your affiliate aggregator + a per-creator/per-video sub-tag,
// so sales can be attributed to the right creator. No-op until AFFILIATE_TEMPLATE is set.
function wrapAffiliate(rawUrl, subid) {
  const t = CFG.AFFILIATE_TEMPLATE;
  if (!t) return rawUrl;
  return t.replace('{URL}', encodeURIComponent(rawUrl)).replace('{SUBID}', encodeURIComponent(subid));
}

const VERTICALS = [
  { id: 'beauty',  label: 'Beauty',  emoji: '💄' },
  { id: 'fashion', label: 'Fashion', emoji: '👗' },
  { id: 'fitness', label: 'Fitness', emoji: '💪' },
  { id: 'home',    label: 'Home',    emoji: '🏠' }
];

const PLANS = [
  { id:'starter',  name:'Starter',  price:10, tagline:'Start posting & earning',
    features:['Up to 10 shoppable videos','Tap-to-shop affiliate links','Basic tap stats'] },
  { id:'pro',      name:'Pro',      price:25, popular:true, tagline:'For growing creators',
    features:['Unlimited videos','Full analytics dashboard','Custom profile links','Priority support'] },
  { id:'business', name:'Business', price:49, tagline:'Go all in',
    features:['Everything in Pro','AI product tagging (soon)','Custom branding','Multiple storefronts'] }
];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const money = (n) => '€' + (Number(n) || 0).toFixed(2);

// avatar: show the photo if set, otherwise a colored circle with the first letter
function avatarHTML(url, name, sizeClass = 'w-9 h-9', textClass = 'font-bold') {
  if (url) return `<img src="${esc(url)}" class="${sizeClass} rounded-full object-cover bg-white/10" alt="" />`;
  return `<div class="${sizeClass} rounded-full bg-brand-600 grid place-items-center ${textClass}">${esc((name||'?')[0]).toUpperCase()}</div>`;
}

/* ---------- ranking algorithm ---------- */
function tapsOf(p) { return (p.products || []).reduce((a, pr) => a + (pr.clicks || 0), 0); }
function scoreOf(p) {
  const taps = tapsOf(p);
  const likes = likeCountOf(p);
  const comments = commentCountOf(p);
  const shares = p.shares || 0;
  const watchSec = (p.watch_ms || 0) / 1000;
  const views = p.views || 0;
  // taps (commerce) count most; then shares > comments > likes > watch > views
  const base = taps * 10 + shares * 8 + comments * 5 + likes * 3 + watchSec * 2 + views * 0.5;
  const freshnessBoost = views < 5 ? (5 - views) * 8 : 0;
  return base + freshnessBoost;
}
// Feed order = performance + freshness (new videos surfaced) + a shuffle so it's never identical.
function feedRank(p) {
  const base = scoreOf(p);                                              // engagement/performance
  const hoursOld = (Date.now() - new Date(p.created_at).getTime()) / 3.6e6;
  const recency = Math.max(0, 60 - hoursOld * 2);                       // new uploads strongly surfaced, fading over ~30h
  const jitter = Math.random() * 35;                                    // variety: reshuffles each time the feed opens
  return base + recency + jitter;
}

function scoreBar(p) {
  const tapPts = tapsOf(p) * 10;
  const engPts = likeCountOf(p) * 3 + commentCountOf(p) * 5 + (p.shares || 0) * 8;
  const watchPts = (p.watch_ms || 0) / 1000 * 2;
  const viewPts = (p.views || 0) * 0.5;
  const boost = (p.views || 0) < 5 ? (5 - (p.views || 0)) * 8 : 0;
  const total = Math.max(1, tapPts + engPts + watchPts + viewPts + boost);
  const pct = (n) => Math.round(n / total * 100);
  const drivers = [['product taps', tapPts], ['likes & comments', engPts], ['watch time', watchPts], ['views', viewPts]].sort((a,b)=>b[1]-a[1]);
  const msg = (tapPts + engPts + watchPts + viewPts) === 0 ? 'No views yet — share it to start climbing 📈' : `Mostly powered by ${drivers[0][0]}.`;
  return `
    <div class="mt-2 h-2.5 w-full rounded-full overflow-hidden flex bg-white/5">
      <div style="width:${pct(tapPts)}%" class="bg-brand-500"></div>
      <div style="width:${pct(engPts)}%" class="bg-emerald-500"></div>
      <div style="width:${pct(watchPts)}%" class="bg-sky-500"></div>
      <div style="width:${pct(viewPts)}%" class="bg-white/40"></div>
      ${boost?`<div style="width:${pct(boost)}%" class="bg-amber-400"></div>`:''}
    </div>
    <div class="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5 text-[10px] text-white/50">
      <span><span class="inline-block w-2 h-2 rounded-full bg-brand-500 mr-1 align-middle"></span>Taps</span>
      <span><span class="inline-block w-2 h-2 rounded-full bg-emerald-500 mr-1 align-middle"></span>Likes/Comments</span>
      <span><span class="inline-block w-2 h-2 rounded-full bg-sky-500 mr-1 align-middle"></span>Watch</span>
      <span><span class="inline-block w-2 h-2 rounded-full bg-white/40 mr-1 align-middle"></span>Views</span>
      ${boost?`<span><span class="inline-block w-2 h-2 rounded-full bg-amber-400 mr-1 align-middle"></span>New boost</span>`:''}
    </div>
    <p class="text-[11px] text-white/45 mt-1">${msg}</p>`;
}

/* ---------- state ---------- */
const state = { me: null, posts: [], booted: false, viewProfile: null, myLikes: new Set(), mySaves: new Set(), feedFocusId: null, earnings: null, payout: null };
function openPostInFeed(postId) { state.feedFocusId = postId; activeTab = 'feed'; render(); }
const likeCountOf = (p) => p.likes?.[0]?.count || 0;
const commentCountOf = (p) => p.comments?.[0]?.count || 0;
let activeTab = 'feed';
let authMode = 'login';   // 'login' | 'signup'
let feedMuted = true;     // videos start muted (autoplay requirement); tap to unmute
const app = document.getElementById('app');

/* Draft persistence for the Create form (so it survives tab-switches & reloads) */
const DRAFT_KEY = 'sr_create_draft';
let createFileObj = null; // chosen video file, kept in memory (survives tab switches, not a full reload)
const loadDraft = () => { try { return JSON.parse(localStorage.getItem(DRAFT_KEY)) || {}; } catch { return {}; } };
const saveDraft = (d) => { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch {} };
const clearDraft = () => { localStorage.removeItem(DRAFT_KEY); createFileObj = null; };

/* ---------- data layer ---------- */
async function loadProfile(userId) {
  const { data } = await sb.from('profiles').select('*').eq('id', userId).maybeSingle();
  return data || null;
}
async function loadPosts() {
  // Try richest query first; fall back to simpler ones so a missing column/table
  // can never blank the feed.
  const selects = [
    '*, products(*), profiles!posts_creator_id_fkey(avatar_url, handle), likes(count), comments(count)',
    '*, products(*), profiles!posts_creator_id_fkey(avatar_url, handle)',
    '*, products(*)',
    '*'
  ];
  for (const sel of selects) {
    const { data, error } = await sb.from('posts').select(sel).order('created_at', { ascending: false });
    if (!error) {
      (data || []).forEach(p => { p.products = (p.products || []).sort((a,b)=>(a.position||0)-(b.position||0)); });
      return data || [];
    }
    console.warn('loadPosts select failed:', sel, '→', error.message);
  }
  return [];
}
async function refreshPosts() { state.posts = await loadPosts(); }

async function loadEarnings() {
  if (!state.me) { state.earnings = null; return; }
  const { data } = await sb.from('creator_earnings').select('*').eq('creator_id', state.me.id).maybeSingle();
  state.earnings = data || { pending: 0, confirmed: 0, sales: 0, clicks: 0, paid_out: 0, currency: 'EUR' };
}
async function loadPayout() {
  if (!state.me) { state.payout = null; return; }
  const { data } = await sb.from('payout_accounts').select('*').eq('user_id', state.me.id).maybeSingle();
  state.payout = data || { paypal_email: '', upi: '', country: '' };
}

async function loadMySocial() {
  if (!state.me) { state.myLikes = new Set(); state.mySaves = new Set(); return; }
  const [{ data: l }, { data: s }] = await Promise.all([
    sb.from('likes').select('post_id').eq('user_id', state.me.id),
    sb.from('saves').select('post_id').eq('user_id', state.me.id)
  ]);
  state.myLikes = new Set((l || []).map(x => x.post_id));
  state.mySaves = new Set((s || []).map(x => x.post_id));
}

async function deletePost(postId, videoUrl) {
  // remove the stored video file if it's one of ours (ignore for external URLs)
  try {
    const marker = '/videos/';
    const i = (videoUrl || '').indexOf(marker);
    if (i !== -1) {
      const path = decodeURIComponent(videoUrl.slice(i + marker.length));
      await sb.storage.from('videos').remove([path]);
    }
  } catch (_) { /* non-fatal */ }
  const { error } = await sb.from('posts').delete().eq('id', postId);   // products cascade-delete
  return error;
}

let _authError = null;

async function ensureProfile(user) {
  _authError = null;
  const existing = await loadProfile(user.id);
  if (existing) return existing;

  const meta = user.user_metadata || {};
  const base = (meta.handle || meta.name || (user.email || 'creator').split('@')[0])
    .toLowerCase().replace(/[^a-z0-9_]/g, '') || 'creator';
  const vertical = meta.vertical || 'beauty';

  // try the base handle, then a suffixed one if it's taken
  for (const handle of [base, base + Math.floor(1000 + Math.random()*9000)]) {
    const { data, error } = await sb.from('profiles')
      .insert({ id: user.id, handle, email: user.email, vertical })
      .select().single();
    if (!error) return data;
    if (error.code !== '23505') {   // not a duplicate -> real error, stop
      _authError = `${error.message}${error.code ? ' (code ' + error.code + ')' : ''}`;
      console.error('ensureProfile error', error);
      return null;
    }
  }
  _authError = 'That handle is already taken — could not create your profile automatically.';
  return null;
}

/* ---------- boot ---------- */
let _appliedUid;
async function applySession(session) {
  const uid = session?.user?.id || null;
  if (state.booted && uid === _appliedUid) return;   // same user already shown — skip redundant re-render
  _appliedUid = uid;
  if (session?.user) {
    if (!state.me || state.me.id !== session.user.id) {
      state.me = await ensureProfile(session.user);
    }
    if (state.me) { await Promise.all([refreshPosts(), loadMySocial(), loadEarnings(), loadPayout()]); state.booted = true; render(); startRealtime(); bindCountSync(); return; }
    // Signed in, but the profile row couldn't be created — show why.
    state.booted = true;
    app.innerHTML = InfoScreen('Signed in, but profile setup failed', _authError || 'Unknown database error', session.user.email);
    wireInfo();
    return;
  }
  state.me = null;
  state.booted = true;
  // If we just came back from Google with an error in the URL, surface it.
  const urlErr = new URLSearchParams(location.search).get('error_description')
              || new URLSearchParams(location.hash.replace(/^#/, '')).get('error_description');
  if (urlErr) { app.innerHTML = InfoScreen('Google sign-in was blocked', decodeURIComponent(urlErr), null); wireInfo(); return; }
  render();
}

function InfoScreen(title, detail, email) {
  return `<div class="h-full grid place-items-center px-7 bg-ink-900 text-center">
    <div class="max-w-sm">
      <div class="text-4xl mb-3">⚠️</div>
      <h1 class="text-xl font-black">${esc(title)}</h1>
      ${email ? `<p class="text-white/60 text-sm mt-1">${esc(email)}</p>` : ''}
      <div class="mt-4 bg-white/5 border border-white/10 rounded-xl p-3 text-left text-xs text-red-300 break-words">${esc(detail)}</div>
      <button id="info-retry" class="w-full mt-5 bg-brand-600 font-bold py-3 rounded-xl">Back to login</button>
    </div></div>`;
}
function wireInfo() {
  const b = app.querySelector('#info-retry');
  if (b) b.onclick = async () => { await sb.auth.signOut(); state.me = null; history.replaceState({}, '', location.pathname); render(); };
}

async function boot() {
  // returning from Stripe checkout?
  if (location.search.includes('sub=success')) {
    history.replaceState({}, '', location.pathname);
  }
  // Catch the sign-in that happens when Google redirects back (fires after the URL is parsed).
  sb.auth.onAuthStateChange((_event, session) => {
    setTimeout(() => applySession(session), 0);   // defer to avoid Supabase callback deadlock
  });
  // Initial check in case no auth event fires.
  const { data: { session } } = await sb.auth.getSession();
  await applySession(session);
}

async function reloadMe() {
  const { data: { session } } = await sb.auth.getSession();
  state.me = session?.user ? await loadProfile(session.user.id) : null;
}

/* ---------- refresh counts when the window regains focus (reliable fallback) ---------- */
let countSyncBound = false;
function bindCountSync() {
  if (countSyncBound) return;
  countSyncBound = true;
  const handler = () => { if (document.visibilityState === 'visible' && state.me) syncCounts(); };
  document.addEventListener('visibilitychange', handler);
  window.addEventListener('focus', handler);
}
async function syncCounts() {
  if (!state.me) return;
  await Promise.all([refreshPosts(), loadMySocial(), loadEarnings(), loadPayout()]);
  if (activeTab === 'feed') {
    // update badges in place so the playing video isn't interrupted
    state.posts.forEach(p => {
      document.querySelectorAll(`.sr-like-count[data-post="${p.id}"]`).forEach(el => el.textContent = likeCountOf(p));
      document.querySelectorAll(`.cm-count[data-post="${p.id}"]`).forEach(el => el.textContent = commentCountOf(p));
      document.querySelectorAll(`.sr-like[data-post="${p.id}"] .sr-like-icon`).forEach(el => el.textContent = state.myLikes.has(p.id) ? '❤️' : '🤍');
    });
  } else {
    render();
  }
}

/* ---------- realtime: live likes / comments / views across all users ---------- */
let realtimeStarted = false;
function bumpBadge(sel, postId, delta) {
  document.querySelectorAll(`${sel}[data-post="${postId}"]`).forEach(el => {
    el.textContent = Math.max(0, (parseInt(el.textContent, 10) || 0) + delta);
  });
}
function startRealtime() {
  if (realtimeStarted) return;
  realtimeStarted = true;
  sb.channel('shopreel-rt')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'likes' }, (payload) => {
      console.log('[realtime] like INSERT', payload.new);
      if (payload.new.user_id === state.me?.id) return;            // we already counted our own
      const p = state.posts.find(x => x.id === payload.new.post_id);
      if (p) { if (p.likes?.[0]) p.likes[0].count++; else p.likes = [{ count: 1 }]; }
      bumpBadge('.sr-like-count', payload.new.post_id, +1);
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'likes' }, (payload) => {
      console.log('[realtime] like DELETE', payload.old);
      if (payload.old.user_id === state.me?.id) return;
      const p = state.posts.find(x => x.id === payload.old.post_id);
      if (p && p.likes?.[0]) p.likes[0].count = Math.max(0, p.likes[0].count - 1);
      bumpBadge('.sr-like-count', payload.old.post_id, -1);
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'comments' }, (payload) => {
      console.log('[realtime] comment INSERT', payload.new);
      if (payload.new.user_id === state.me?.id) return;
      const p = state.posts.find(x => x.id === payload.new.post_id);
      if (p) { if (p.comments?.[0]) p.comments[0].count++; else p.comments = [{ count: 1 }]; }
      bumpBadge('.cm-count', payload.new.post_id, +1);
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'posts' }, (payload) => {
      const p = state.posts.find(x => x.id === payload.new.id);
      if (p) { p.views = payload.new.views; p.watch_ms = payload.new.watch_ms; p.shares = payload.new.shares; }
      if (activeTab === 'dashboard') render();   // live-update the Stats page
    })
    .subscribe((status) => console.log('[realtime] channel status:', status));
}

/* ---------- router ---------- */
function render() {
  if (!state.booted) { app.innerHTML = Splash('Loading…'); return; }
  if (!state.me) { app.innerHTML = AuthScreen(); wireAuth(); return; }
  let body = '';
  if (activeTab === 'feed') body = FeedScreen();
  else if (activeTab === 'create') body = CreateScreen();
  else if (activeTab === 'subscribe') body = SubscribeScreen();
  else if (activeTab === 'dashboard') body = DashboardScreen();
  else if (activeTab === 'profile') body = ProfileScreen();
  else if (activeTab === 'settings') body = SettingsScreen();
  else if (activeTab === 'creator') body = CreatorScreen();
  app.innerHTML = body + (activeTab === 'settings' ? '' : NavBar());
  wireCommon();
  if (activeTab === 'feed') wireFeed();
  if (activeTab === 'create') wireCreate();
  if (activeTab === 'subscribe') wireSubscribe();
  if (activeTab === 'profile') wireProfile();
  if (activeTab === 'settings') wireSettings();
  if (activeTab === 'creator') wireCreator();
}

function Splash(msg) {
  return `<div class="h-full grid place-items-center bg-gradient-to-b from-brand-600 to-purple-700">
    <div class="text-center"><div class="inline-grid place-items-center w-16 h-16 rounded-2xl bg-white/15 text-3xl mb-3 animate-pulse">▶</div>
    <p class="text-white/80">${esc(msg)}</p></div></div>`;
}

/* ---------- auth screen ---------- */
function AuthScreen() {
  const signup = authMode === 'signup';
  return `
  <div class="h-full overflow-y-auto no-scrollbar flex flex-col justify-center px-7 bg-gradient-to-b from-brand-600 to-purple-700">
    <div class="text-center mb-8">
      <div class="inline-grid place-items-center w-16 h-16 rounded-2xl bg-white/15 text-3xl mb-4">▶</div>
      <h1 class="text-3xl font-black">ShopReel</h1>
      <p class="text-white/80 mt-2">Turn your videos into shoppable storefronts.</p>
    </div>
    <div class="bg-white text-ink-900 rounded-2xl p-6 shadow-2xl">
      <div class="flex bg-gray-100 rounded-xl p-1 mb-4 text-sm font-semibold">
        <button class="au-tab flex-1 py-2 rounded-lg ${!signup?'bg-white shadow':''}" data-mode="login">Log in</button>
        <button class="au-tab flex-1 py-2 rounded-lg ${signup?'bg-white shadow':''}" data-mode="signup">Sign up</button>
      </div>
      <button id="au-google" class="w-full flex items-center justify-center gap-2 border border-gray-300 rounded-xl py-3 font-semibold hover:bg-gray-50">
        <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
        Continue with Google
      </button>
      <div class="flex items-center gap-2 my-4 text-gray-400 text-xs"><div class="flex-1 h-px bg-gray-200"></div>or<div class="flex-1 h-px bg-gray-200"></div></div>
      ${signup ? `
        <label class="text-sm font-semibold">Handle</label>
        <div class="flex items-center mt-1 rounded-xl border border-gray-300"><span class="pl-3 text-gray-400">@</span>
          <input id="au-handle" placeholder="glowbymia" class="flex-1 px-2 py-3 outline-none rounded-xl" /></div>
        <p class="text-sm font-semibold mt-3">Your space</p>
        <div id="au-verticals" class="flex gap-2 mt-1 flex-wrap">
          ${VERTICALS.map((v,i)=>`<button data-v="${v.id}" class="au-v px-3 py-2 rounded-full border text-sm ${i===0?'bg-brand-600 text-white border-brand-600':'border-gray-300'}">${v.emoji} ${v.label}</button>`).join('')}
        </div>` : ''}
      <label class="text-sm font-semibold mt-4 block">Email</label>
      <input id="au-email" type="email" placeholder="you@email.com" class="w-full mt-1 px-4 py-3 rounded-xl border border-gray-300 outline-none focus:border-brand-500" />
      <label class="text-sm font-semibold mt-3 block">Password</label>
      <input id="au-pass" type="password" placeholder="••••••••" class="w-full mt-1 px-4 py-3 rounded-xl border border-gray-300 outline-none focus:border-brand-500" />
      <button id="au-go" class="w-full mt-5 bg-brand-600 text-white font-bold py-3 rounded-xl">${signup?'Create account':'Log in'}</button>
      <p id="au-msg" class="text-sm mt-2 h-5 text-center"></p>
    </div>
  </div>`;
}

/* ---------- feed ---------- */
function FeedScreen() {
  // compute each video's feed rank ONCE (random jitter fixed per render), then sort
  const posts = state.posts.map(p => ({ p, r: feedRank(p) })).sort((a, b) => b.r - a.r).map(x => x.p);
  if (!posts.length) {
    return `<div class="h-full grid place-items-center text-center px-8 bg-black">
      <div><div class="text-5xl mb-3">🎬</div><p class="font-bold text-lg">No videos yet</p>
      <p class="text-white/60 mt-1">Tap ➕ Create to post the first shoppable video.</p></div></div>`;
  }
  return `<div class="feed h-full overflow-y-scroll no-scrollbar bg-black">${posts.map(PostCard).join('')}<div class="h-20"></div></div>`;
}

function PostCard(p) {
  const v = VERTICALS.find(x=>x.id===p.vertical);
  return `
  <div class="snap relative h-[100dvh] w-full bg-black flex items-end" data-post="${p.id}">
    <video class="sr-video absolute inset-0 w-full h-full object-cover" muted loop playsinline preload="metadata" ${p.poster_url?`poster="${esc(p.poster_url)}"`:''} src="${esc(p.video_url)}"></video>
    <div class="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/30 pointer-events-none"></div>
    <button class="sr-mute absolute top-4 right-4 z-20 w-10 h-10 rounded-full bg-black/40 backdrop-blur grid place-items-center text-lg">🔇</button>

    <div class="absolute right-3 bottom-40 z-20 flex flex-col items-center gap-4">
      <button class="sr-like flex flex-col items-center" data-post="${p.id}">
        <span class="sr-like-icon text-3xl drop-shadow">${state.myLikes.has(p.id)?'❤️':'🤍'}</span>
        <span class="sr-like-count text-xs font-semibold drop-shadow">${likeCountOf(p)}</span>
      </button>
      <button class="sr-comment flex flex-col items-center" data-post="${p.id}">
        <span class="text-3xl drop-shadow">💬</span>
        <span class="cm-count text-xs font-semibold drop-shadow" data-post="${p.id}">${commentCountOf(p)}</span>
      </button>
      <button class="sr-save flex flex-col items-center" data-post="${p.id}">
        <span class="text-3xl drop-shadow">🔖</span>
        <span class="sr-save-label text-xs font-semibold drop-shadow ${state.mySaves.has(p.id)?'text-brand-500':''}">${state.mySaves.has(p.id)?'Saved':'Save'}</span>
      </button>
      <button class="sr-share flex flex-col items-center" data-post="${p.id}">
        <span class="text-3xl drop-shadow">↗️</span>
        <span class="text-xs font-semibold drop-shadow">Share</span>
      </button>
    </div>

    <div class="relative w-full post-actions" style="padding-right:4.75rem">
      <button class="sr-creator flex items-center gap-2 mb-2" data-creator="${p.creator_id}">
        ${avatarHTML(p.profiles?.avatar_url, p.handle)}
        <span class="font-bold">@${esc(p.handle)}</span>
        ${v?`<span class="text-xs bg-white/15 px-2 py-0.5 rounded-full">${v.emoji} ${v.label}</span>`:''}
      </button>
      <p class="text-sm text-white/90 mb-3 line-clamp-2">${esc(p.caption)}</p>
      <div class="flex gap-2 overflow-x-auto no-scrollbar pb-1">
        ${(p.products||[]).map(pr=>`
          <button class="sr-buy shrink-0 bg-white text-ink-900 rounded-2xl px-3 py-2 flex items-center gap-2 shadow-lg" data-link="${esc(pr.link)}" data-prod="${pr.id}">
            <span class="w-9 h-9 rounded-lg bg-brand-100 grid place-items-center text-lg overflow-hidden">${pr.image?`<img src="${esc(pr.image)}" class="w-9 h-9 object-cover"/>`:(v?v.emoji:'🛍️')}</span>
            <span class="text-left leading-tight"><span class="block text-xs font-bold max-w-[120px] truncate">${esc(pr.title)}</span>
            <span class="block text-xs text-gray-500">${money(pr.price)} · Shop ›</span></span>
          </button>`).join('')}
      </div>
    </div>
  </div>`;
}

/* ---------- create ---------- */
function CreateScreen() {
  const d = loadDraft();
  const vsel = d.vertical || 'beauty';
  const products = (Array.isArray(d.products) && d.products.length) ? d.products : [{}];
  return `
  <div class="h-full overflow-y-auto no-scrollbar bg-ink-900 pb-28">
    <div class="px-5 pt-12 pb-4 flex items-start justify-between gap-3">
      <div><h1 class="text-2xl font-black">New shoppable video</h1>
      <p class="text-white/50 text-sm">Upload a video and tag your affiliate products.</p></div>
      <button id="cr-discard" class="shrink-0 w-9 h-9 mt-1 grid place-items-center rounded-full bg-white/10 border border-white/15 text-white/70 text-sm" aria-label="Discard">✕</button>
    </div>
    <div id="cr-form" class="px-5 space-y-5">
      <div>
        <p class="text-sm font-semibold mb-2">Video <span class="text-white/40 font-normal">· max 2 min</span></p>
        <div class="grid grid-cols-2 gap-2">
          <label class="flex flex-col items-center justify-center gap-1 border-2 border-dashed border-white/20 rounded-2xl py-5 cursor-pointer active:bg-white/5">
            <input id="cr-record" type="file" accept="video/*" capture="environment" class="hidden" />
            <span class="text-2xl">🎥</span><span class="text-white/70 text-sm font-semibold">Record</span>
          </label>
          <label class="flex flex-col items-center justify-center gap-1 border-2 border-dashed border-white/20 rounded-2xl py-5 cursor-pointer active:bg-white/5">
            <input id="cr-pick" type="file" accept="video/*" class="hidden" />
            <span class="text-2xl">📁</span><span class="text-white/70 text-sm font-semibold">Upload</span>
          </label>
        </div>
        <p id="cr-file-label" class="text-center text-sm mt-2 ${createFileObj?'text-green-400':'text-white/40'}">${createFileObj ? '✅ ' + esc(createFileObj.name) : 'Record a new video, or pick one from your gallery'}</p>
        <p class="text-center text-white/30 text-xs my-2">— or paste a link —</p>
        <input id="cr-url" value="${esc(d.url||'')}" placeholder="Paste a video URL (.mp4)" class="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/15 outline-none focus:border-brand-500" />
      </div>
      <div>
        <p class="text-sm font-semibold mb-2">Space</p>
        <div id="cr-verticals" class="flex gap-2 flex-wrap">
          ${VERTICALS.map(v=>`<button data-v="${v.id}" class="cr-v px-3 py-2 rounded-full border text-sm ${vsel===v.id?'bg-brand-600 text-white border-brand-600':'border-white/20'}">${v.emoji} ${v.label}</button>`).join('')}
        </div>
      </div>
      <div><p class="text-sm font-semibold mb-1">Caption</p>
        <textarea id="cr-caption" rows="2" placeholder="Tell viewers what they're watching…" class="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/15 outline-none focus:border-brand-500">${esc(d.caption||'')}</textarea></div>
      <div>
        <div class="flex items-center justify-between mb-2"><p class="text-sm font-semibold">Products</p>
          <button id="cr-add-prod" class="text-brand-500 text-sm font-bold">+ Add product</button></div>
        <div id="cr-products" class="space-y-3">${products.map((p,i)=>ProductRow(i,p)).join('')}</div>
      </div>
      <button id="cr-publish" class="w-full bg-brand-600 font-bold py-3.5 rounded-xl">Publish video</button>
      <p id="cr-msg" class="text-center text-sm h-4"></p>
    </div>
  </div>`;
}

function ProductRow(idx, p = {}) {
  return `<div class="cr-prod bg-white/5 border border-white/10 rounded-2xl p-3 space-y-2" data-idx="${idx}">
    <div class="flex items-center justify-between"><span class="text-xs text-white/40">Product ${idx+1}</span>
      <button class="cr-del-prod text-white/40 text-sm">✕</button></div>
    <input class="cr-p-title w-full px-3 py-2 rounded-lg bg-white/5 border border-white/15 outline-none text-sm" placeholder="Product name" value="${esc(p.title||'')}" />
    <div class="flex gap-2">
      <input class="cr-p-price w-24 px-3 py-2 rounded-lg bg-white/5 border border-white/15 outline-none text-sm" placeholder="Price" inputmode="decimal" value="${esc(p.price||'')}" />
      <input class="cr-p-image flex-1 px-3 py-2 rounded-lg bg-white/5 border border-white/15 outline-none text-sm" placeholder="Image URL (optional)" value="${esc(p.image||'')}" />
    </div>
    <input class="cr-p-link w-full px-3 py-2 rounded-lg bg-white/5 border border-white/15 outline-none text-sm" placeholder="Your affiliate link (https://…)" value="${esc(p.link||'')}" />
  </div>`;
}

/* ---------- subscribe ---------- */
function SubscribeScreen() {
  return `
  <div class="h-full overflow-y-auto no-scrollbar bg-ink-900 pb-28">
    <div class="px-5 pt-12 pb-2 flex items-center justify-between">
      <h1 class="text-2xl font-black">Choose your plan</h1>
      <button class="sub-close text-white/50 text-2xl leading-none">✕</button>
    </div>
    <p class="px-5 text-white/50 text-sm mb-5">Subscribe to publish shoppable videos. Cancel anytime.</p>
    <div class="px-5 space-y-4">
      ${PLANS.map(pl => `
        <div class="rounded-2xl border ${pl.popular?'border-brand-500 bg-brand-500/10':'border-white/15 bg-white/5'} p-5 relative">
          ${pl.popular?`<span class="absolute -top-3 left-5 bg-brand-600 text-white text-[11px] font-bold px-2.5 py-1 rounded-full">MOST POPULAR</span>`:''}
          <div class="flex items-baseline justify-between"><p class="font-bold text-lg">${pl.name}</p>
            <p class="text-2xl font-black">€${pl.price}<span class="text-sm font-medium text-white/50">/mo</span></p></div>
          <p class="text-white/50 text-sm mt-0.5">${pl.tagline}</p>
          <ul class="mt-3 space-y-1.5">${pl.features.map(f=>`<li class="text-sm text-white/80 flex gap-2"><span class="text-brand-500">✓</span>${esc(f)}</li>`).join('')}</ul>
          <button class="sub-pick w-full mt-4 font-bold py-3 rounded-xl ${pl.popular?'bg-brand-600':'bg-white/10 border border-white/20'}" data-plan="${pl.id}">
            Choose ${pl.name} — €${pl.price}/mo</button>
        </div>`).join('')}
    </div>
    <p class="px-8 text-center text-white/30 text-xs mt-5">${STRIPE_READY?'Secure payment by Stripe.':'Demo mode: no real charge until Stripe is connected & deployed.'}</p>
  </div>`;
}

/* ---------- dashboard ---------- */
function DashboardScreen() {
  const mine = state.posts.filter(p => p.creator_id === state.me.id).sort((a,b)=>scoreOf(b)-scoreOf(a));
  const totalClicks = mine.reduce((s,p)=>s+tapsOf(p),0);
  const totalViews = mine.reduce((s,p)=>s+(p.views||0),0);
  const e = state.earnings || { pending: 0, confirmed: 0, sales: 0, paid_out: 0, currency: 'EUR' };
  const confirmed = Number(e.confirmed)||0, pending = Number(e.pending)||0, paid = Number(e.paid_out)||0;
  const payable = Math.max(0, confirmed - paid);
  const hasPayout = state.payout && (state.payout.paypal_email || state.payout.upi);
  return `
  <div class="h-full overflow-y-auto no-scrollbar bg-ink-900 pb-28">
    <div class="px-5 pt-12 pb-4"><h1 class="text-2xl font-black">Your dashboard</h1></div>
    <div class="px-5 mb-5">
      <div class="rounded-2xl bg-gradient-to-br from-brand-600 to-purple-700 p-5 shadow-lg shadow-brand-600/20">
        <p class="text-white/80 text-sm font-semibold">💰 Available to withdraw</p>
        <p class="text-4xl font-black mt-1">€${payable.toFixed(2)}</p>
        <div class="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-white/85">
          <span>⏳ Pending €${pending.toFixed(2)}</span>
          <span>✅ Confirmed €${confirmed.toFixed(2)}</span>
          <span>💸 Paid out €${paid.toFixed(2)}</span>
        </div>
        <p class="text-white/65 text-[11px] mt-2">From ${e.sales||0} sale${(e.sales||0)===1?'':'s'} · pending clears after retailer return windows.</p>
        ${hasPayout ? '' : `<button class="pf-payout-cta mt-3 bg-white text-brand-700 text-sm font-bold px-3 py-1.5 rounded-lg">＋ Add payout details</button>`}
      </div>
    </div>
    <div class="px-5 grid grid-cols-3 gap-3 mb-6">
      <div class="bg-white/5 border border-white/10 rounded-2xl p-4"><p class="text-2xl font-black">${mine.length}</p><p class="text-white/50 text-xs">Videos</p></div>
      <div class="bg-white/5 border border-white/10 rounded-2xl p-4"><p class="text-2xl font-black">${totalViews}</p><p class="text-white/50 text-xs">Views</p></div>
      <div class="bg-white/5 border border-white/10 rounded-2xl p-4"><p class="text-2xl font-black text-brand-500">${totalClicks}</p><p class="text-white/50 text-xs">Taps</p></div>
    </div>
    <div class="px-5 space-y-3">
      ${mine.length ? mine.map((p,i)=>`
        <div class="bg-white/5 border border-white/10 rounded-2xl p-4">
          <div class="flex items-center gap-2">
            <span class="shrink-0 w-6 h-6 rounded-full ${i===0?'bg-brand-600':'bg-white/10'} grid place-items-center text-xs font-bold">#${i+1}</span>
            <p class="font-semibold text-sm line-clamp-1 flex-1">${esc(p.caption)||'(no caption)'}</p>
            <span class="shrink-0 text-xs font-bold text-brand-500">🔥 ${Math.round(scoreOf(p))}</span></div>
          <div class="flex gap-4 mt-2 text-xs text-white/50">
            <span>👁 ${p.views||0} views</span><span>⏱ ${Math.round((p.watch_ms||0)/1000)}s</span><span>👆 ${tapsOf(p)} taps</span></div>
          ${scoreBar(p)}
          <div class="mt-2 pt-2 border-t border-white/5 space-y-1">
            ${(p.products||[]).map(pr=>`<div class="flex justify-between text-sm"><span class="text-white/70">${esc(pr.title)}</span><span class="text-brand-500 font-bold">${pr.clicks||0} taps</span></div>`).join('')||'<span class="text-white/30 text-sm">No products</span>'}
          </div>
        </div>`).join('')
        : `<p class="text-white/40 text-center mt-10">No videos yet. Tap ➕ to create your first.</p>`}
    </div>
    <p class="text-white/30 text-xs text-center mt-8 px-8">🔥 = performance score. Real sales appear in your affiliate account.</p>
  </div>`;
}

/* ---------- profile ---------- */
function ProfileScreen() {
  const u = state.me;
  const v = VERTICALS.find(x=>x.id===u.vertical);
  const mine = state.posts.filter(p => p.creator_id === u.id).sort((a,b)=>b.created_at>a.created_at?1:-1);
  const plan = PLANS.find(p=>p.id===u.plan);
  const links = u.links || [];
  const saved = state.posts.filter(p => state.mySaves.has(p.id));
  return `
  <div class="h-full overflow-y-auto no-scrollbar bg-ink-900 pb-28">
    <div class="px-5 pt-12 flex items-center justify-between">
      <h1 class="text-2xl font-black">Profile</h1>
      <button class="pf-settings w-10 h-10 grid place-items-center rounded-full bg-white/10 border border-white/15 text-lg" aria-label="Settings">⚙️</button>
    </div>
    <div class="px-5 mt-5 flex items-center gap-4">
      ${avatarHTML(u.avatar_url, u.handle, 'w-16 h-16', 'text-2xl font-black')}
      <div><p class="text-xl font-bold">@${esc(u.handle)}</p>
      <div class="flex gap-1.5 mt-1">
        ${v?`<span class="text-xs bg-white/10 px-2 py-0.5 rounded-full">${v.emoji} ${v.label}</span>`:''}
        ${plan?`<span class="text-xs bg-brand-600 px-2 py-0.5 rounded-full">${plan.name} · €${plan.price}/mo</span>`:`<span class="text-xs bg-white/10 px-2 py-0.5 rounded-full text-white/60">No plan</span>`}
      </div></div>
    </div>
    <div class="px-5 mt-7">
      <p class="text-sm font-semibold mb-2">My links</p>
      <div id="pf-links" class="flex flex-wrap gap-2 mb-3">
        ${links.length ? links.map(l=>`
          <span class="inline-flex items-center gap-1 bg-white/10 border border-white/15 rounded-full pl-3 pr-1.5 py-1 text-sm">
            <a href="${esc(l.url)}" target="_blank" rel="noopener" class="max-w-[140px] truncate">🔗 ${esc(l.label)}</a>
            <button class="pf-del-link w-5 h-5 grid place-items-center text-white/50" data-id="${esc(l.id)}">✕</button></span>`).join('')
          : `<span class="text-white/30 text-sm">No links yet — add your shop, Insta, TikTok…</span>`}
      </div>
      <div class="flex gap-2">
        <input id="pf-link-label" placeholder="Label" class="w-1/3 px-3 py-2 rounded-lg bg-white/5 border border-white/15 outline-none text-sm" />
        <input id="pf-link-url" placeholder="https://…" class="flex-1 px-3 py-2 rounded-lg bg-white/5 border border-white/15 outline-none text-sm" />
        <button id="pf-add-link" class="bg-brand-600 px-4 rounded-lg font-bold text-sm">Add</button>
      </div>
      <p id="pf-link-msg" class="text-red-400 text-xs h-4 mt-1"></p>
    </div>
    <div class="px-5 mt-4">
      <p class="text-sm font-semibold mb-2">My videos <span class="text-white/40 font-normal">(${mine.length})</span></p>
      ${mine.length ? `<div class="grid grid-cols-3 gap-1">${mine.map(p=>`
          <div class="relative aspect-[9/16] bg-white/10 rounded-lg overflow-hidden">
            ${p.poster_url
              ? `<img class="pf-vid w-full h-full object-cover" src="${esc(p.poster_url)}" data-post="${p.id}" alt="" />`
              : `<video class="pf-vid w-full h-full object-cover" muted playsinline preload="metadata" src="${esc(p.video_url)}#t=0.1" data-post="${p.id}"></video>`}
            <span class="absolute inset-x-1 bottom-1 text-[10px] text-white line-clamp-1 drop-shadow text-left pointer-events-none">${esc(p.caption)||''}</span>
            <span class="absolute top-1 right-1 text-[10px] bg-black/50 rounded px-1 pointer-events-none">${tapsOf(p)} 👆</span>
            <button class="pf-del-vid absolute top-1 left-1 w-7 h-7 rounded-full bg-black/60 backdrop-blur grid place-items-center text-xs" data-post="${p.id}" data-url="${esc(p.video_url)}" aria-label="Delete video">🗑️</button>
          </div>`).join('')}</div>`
        : `<div class="border border-dashed border-white/15 rounded-2xl p-6 text-center">
             <p class="text-white/50 text-sm">You haven't posted any videos yet.</p>
             <button class="pf-create-cta mt-3 bg-brand-600 px-4 py-2 rounded-xl text-sm font-bold">＋ Create your first</button></div>`}
    </div>
    <div class="px-5 mt-4">
      <p class="text-sm font-semibold mb-2">🔖 Saved <span class="text-white/40 font-normal">(${saved.length})</span></p>
      ${saved.length ? `<div class="grid grid-cols-3 gap-1">${saved.map(p=>`
        <button class="pf-vid relative aspect-[9/16] bg-white/10 rounded-lg overflow-hidden" data-post="${p.id}">
          ${p.poster_url ? `<img class="w-full h-full object-cover" src="${esc(p.poster_url)}" alt="" />` : `<video class="w-full h-full object-cover" muted playsinline preload="metadata" src="${esc(p.video_url)}#t=0.1"></video>`}
          <span class="absolute inset-x-1 bottom-1 text-[10px] text-white line-clamp-1 drop-shadow text-left">@${esc(p.handle)}</span>
        </button>`).join('')}</div>`
        : `<p class="text-white/40 text-sm">Videos you save will appear here.</p>`}
    </div>
    <div class="px-5 mt-7"><button id="pf-logout" class="w-full border border-white/20 py-3 rounded-xl font-semibold">Log out</button></div>
  </div>`;
}

/* ---------- settings ---------- */
function SettingsScreen() {
  const u = state.me;
  const p = state.payout || {};
  return `
  <div class="h-full overflow-y-auto no-scrollbar bg-ink-900 pb-12">
    <div class="px-5 pt-12 flex items-center gap-3">
      <button class="set-back w-10 h-10 grid place-items-center rounded-full bg-white/10 border border-white/15 text-lg">←</button>
      <h1 class="text-2xl font-black">Settings</h1></div>
    <div class="px-5 mt-7 space-y-5">
      <div class="flex items-center gap-4">
        ${avatarHTML(u.avatar_url, u.handle, 'w-20 h-20', 'text-3xl font-black')}
        <label class="cursor-pointer">
          <input id="set-avatar" type="file" accept="image/*" class="hidden" />
          <span class="inline-block bg-white/10 border border-white/20 px-4 py-2 rounded-xl text-sm font-semibold">Change photo</span>
        </label>
      </div>
      <p id="set-avatar-msg" class="text-xs h-4 text-white/50 -mt-3"></p>
      <div><label class="text-sm font-semibold">Handle / creator name</label>
        <div class="flex items-center mt-1 rounded-xl bg-white/5 border border-white/15 focus-within:border-brand-500">
          <span class="pl-3 text-white/40">@</span>
          <input id="set-handle" value="${esc(u.handle)}" class="flex-1 px-2 py-3 bg-transparent outline-none" /></div>
        <p class="text-white/30 text-xs mt-1">Changing this updates the name shown on all your videos.</p></div>
      <div><label class="text-sm font-semibold">Your space</label>
        <div id="set-verticals" class="flex gap-2 flex-wrap mt-2">
          ${VERTICALS.map(v=>`<button data-v="${v.id}" class="set-v px-3 py-2 rounded-full border text-sm ${u.vertical===v.id?'bg-brand-600 text-white border-brand-600':'border-white/20'}">${v.emoji} ${v.label}</button>`).join('')}
        </div></div>

      <div class="pt-2 border-t border-white/10">
        <label class="text-sm font-semibold">💸 Payout details <span class="text-white/40 font-normal">— how you get paid</span></label>
        <input id="set-paypal" value="${esc(p.paypal_email||'')}" type="email" placeholder="PayPal email" class="w-full mt-2 px-4 py-3 rounded-xl bg-white/5 border border-white/15 outline-none focus:border-brand-500" />
        <input id="set-upi" value="${esc(p.upi||'')}" placeholder="UPI ID (India — optional)" class="w-full mt-2 px-4 py-3 rounded-xl bg-white/5 border border-white/15 outline-none focus:border-brand-500" />
        <p class="text-white/30 text-xs mt-1">Add your PayPal so we can send your earnings once they're confirmed.</p>
      </div>

      <button id="set-save" class="w-full bg-brand-600 font-bold py-3.5 rounded-xl">Save changes</button>
      <p id="set-msg" class="text-center text-sm h-4"></p>
    </div>
  </div>`;
}

/* ---------- creator (public) profile ---------- */
async function openCreator(id) {
  if (state.me && id === state.me.id) { activeTab = 'profile'; render(); return; }  // your own
  state.viewProfile = null; activeTab = 'creator'; render();   // show loading
  const { data } = await sb.from('profiles').select('*').eq('id', id).maybeSingle();
  state.viewProfile = data || { id, handle: 'unknown' };
  render();
}

function CreatorScreen() {
  const u = state.viewProfile;
  if (!u) return Splash('Loading…') + '';
  const v = VERTICALS.find(x => x.id === u.vertical);
  const vids = state.posts.filter(p => p.creator_id === u.id).sort((a,b)=> b.created_at>a.created_at?1:-1);
  const links = u.links || [];
  return `
  <div class="h-full overflow-y-auto no-scrollbar bg-ink-900 pb-28">
    <div class="px-5 pt-12 flex items-center gap-3">
      <button class="cre-back w-10 h-10 grid place-items-center rounded-full bg-white/10 border border-white/15 text-lg">←</button>
      <h1 class="text-2xl font-black truncate">@${esc(u.handle)}</h1>
    </div>
    <div class="px-5 mt-5 flex items-center gap-4">
      ${avatarHTML(u.avatar_url, u.handle, 'w-16 h-16', 'text-2xl font-black')}
      <div>
        ${v?`<span class="text-xs bg-white/10 px-2 py-0.5 rounded-full">${v.emoji} ${v.label}</span>`:''}
        <p class="text-white/50 text-sm mt-1">${vids.length} video${vids.length===1?'':'s'}</p>
      </div>
    </div>
    ${links.length ? `<div class="px-5 mt-4 flex flex-wrap gap-2">${links.map(l=>`<a href="${esc(l.url)}" target="_blank" rel="noopener" class="bg-white/10 border border-white/15 rounded-full px-3 py-1 text-sm">🔗 ${esc(l.label)}</a>`).join('')}</div>`:''}
    <div class="px-5 mt-5">
      <p class="text-sm font-semibold mb-2">Videos</p>
      ${vids.length ? `<div class="grid grid-cols-3 gap-1">${vids.map(p=>`
        <button class="cre-vid relative aspect-[9/16] bg-white/10 rounded-lg overflow-hidden" data-post="${p.id}">
          ${p.poster_url ? `<img class="w-full h-full object-cover" src="${esc(p.poster_url)}" alt="" />` : `<video class="w-full h-full object-cover" muted playsinline preload="metadata" src="${esc(p.video_url)}#t=0.1"></video>`}
          <span class="absolute inset-x-1 bottom-1 text-[10px] text-white line-clamp-1 drop-shadow text-left">${esc(p.caption)||''}</span>
        </button>`).join('')}</div>`
        : `<p class="text-white/40 text-sm">No videos yet.</p>`}
    </div>
  </div>`;
}
function wireCreator() {
  const back = app.querySelector('.cre-back');
  if (back) back.onclick = () => { activeTab = 'feed'; render(); };
  app.querySelectorAll('.cre-vid').forEach(b => b.onclick = () => openPostInFeed(b.dataset.post));
}

/* ---------- nav ---------- */
function NavBar() {
  const ICONS = {
    feed: '<path d="M11.47 3.84a.75.75 0 011.06 0l8.69 8.69a.75.75 0 11-1.06 1.06l-.69-.69v6.69A1.875 1.875 0 0117.6 21.45H15a.75.75 0 01-.75-.75v-4.5a.75.75 0 00-.75-.75h-3a.75.75 0 00-.75.75v4.5a.75.75 0 01-.75.75H6.4a1.875 1.875 0 01-1.86-1.86V12.9l-.69.69a.75.75 0 11-1.06-1.06l8.68-8.69z"/>',
    dashboard: '<path d="M3 13.125c0-1.036.84-1.875 1.875-1.875h.75c1.036 0 1.875.84 1.875 1.875v6.75c0 1.035-.84 1.875-1.875 1.875h-.75A1.875 1.875 0 013 19.875v-6.75zM9.75 8.625c0-1.036.84-1.875 1.875-1.875h.75c1.036 0 1.875.84 1.875 1.875v11.25c0 1.035-.84 1.875-1.875 1.875h-.75a1.875 1.875 0 01-1.875-1.875V8.625zM16.5 4.125c0-1.036.84-1.875 1.875-1.875h.75c1.035 0 1.875.84 1.875 1.875v15.75c0 1.035-.84 1.875-1.875 1.875h-.75a1.875 1.875 0 01-1.875-1.875V4.125z"/>',
    profile: '<path fill-rule="evenodd" d="M7.5 6a4.5 4.5 0 119 0 4.5 4.5 0 01-9 0zM3.751 20.105a8.25 8.25 0 0116.498 0 .75.75 0 01-.437.695A18.683 18.683 0 0112 22.5c-2.786 0-5.433-.608-7.812-1.7a.75.75 0 01-.437-.695z" clip-rule="evenodd"/>'
  };
  const tab = (id, label) => `
    <button class="nav-tab flex-1 flex flex-col items-center justify-center gap-1 transition-colors ${activeTab===id?'text-white':'text-white/45'}" data-tab="${id}">
      <span class="grid place-items-center w-10 h-8 rounded-2xl transition ${activeTab===id?'bg-white/20':''}">
        <svg width="21" height="21" viewBox="0 0 24 24" fill="currentColor">${ICONS[id]}</svg>
      </span>
      <span class="text-[10px] font-semibold leading-none">${label}</span>
    </button>`;
  const createActive = (activeTab==='create'||activeTab==='subscribe');
  return `
  <nav class="fixed z-30 left-1/2 -translate-x-1/2 w-full max-w-[480px] px-3" style="bottom:calc(0.75rem + env(safe-area-inset-bottom))">
    <div class="relative flex items-stretch h-[4.25rem] rounded-[1.75rem] bg-white/10 backdrop-blur-2xl border border-white/15 shadow-2xl shadow-black/50 px-1">
      <div class="absolute inset-0 rounded-[1.75rem] bg-gradient-to-b from-white/10 to-transparent pointer-events-none"></div>
      ${tab('feed','Feed')}
      ${tab('dashboard','Stats')}
      <button class="nav-tab flex-1 flex flex-col items-center justify-center gap-1" data-tab="create">
        <span class="w-10 h-8 rounded-2xl bg-gradient-to-br from-brand-500 to-purple-600 grid place-items-center shadow-lg shadow-brand-600/50 ${createActive?'ring-2 ring-white/50':''}">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        </span>
        <span class="text-[10px] font-semibold leading-none ${createActive?'text-white':'text-white/45'}">Create</span>
      </button>
      ${tab('profile','Profile')}
    </div>
  </nav>`;
}

/* ---------- wiring ---------- */
function wireAuth() {
  let vertical = 'beauty';
  app.querySelectorAll('.au-tab').forEach(b => b.onclick = () => { authMode = b.dataset.mode; render(); });
  const gbtn = app.querySelector('#au-google');
  if (gbtn) gbtn.onclick = async () => {
    const msg = app.querySelector('#au-msg');
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + window.location.pathname }
    });
    if (error) { msg.className='text-sm mt-2 h-5 text-center text-red-600'; msg.textContent = error.message; }
  };
  app.querySelectorAll('.au-v').forEach(b => b.onclick = () => {
    vertical = b.dataset.v;
    app.querySelectorAll('.au-v').forEach(x => x.className = 'au-v px-3 py-2 rounded-full border text-sm border-gray-300');
    b.className = 'au-v px-3 py-2 rounded-full border text-sm bg-brand-600 text-white border-brand-600';
  });
  app.querySelector('#au-go').onclick = async () => {
    const email = app.querySelector('#au-email').value.trim();
    const pass = app.querySelector('#au-pass').value;
    const msg = app.querySelector('#au-msg');
    const setErr = (t) => { msg.className='text-sm mt-2 h-5 text-center text-red-600'; msg.textContent=t; };
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return setErr('Enter a valid email.');
    if (pass.length < 6) return setErr('Password must be at least 6 characters.');
    msg.className='text-sm mt-2 h-5 text-center text-gray-500'; msg.textContent='Please wait…';

    if (authMode === 'signup') {
      const handle = (app.querySelector('#au-handle').value || '').trim();
      if (!handle) return setErr('Pick a handle.');
      const { data, error } = await sb.auth.signUp({ email, password: pass, options: { data: { handle, vertical } } });
      if (error) return setErr(error.message);
      if (data.session?.user) {
        state.me = await ensureProfile(data.session.user);
        await refreshPosts(); activeTab = 'feed'; render();
      } else {
        msg.className='text-sm mt-2 h-5 text-center text-green-600';
        msg.textContent='Check your email to confirm, then log in.';
      }
    } else {
      const { data, error } = await sb.auth.signInWithPassword({ email, password: pass });
      if (error) return setErr(error.message);
      state.me = await ensureProfile(data.user);
      await refreshPosts(); activeTab = 'feed'; render();
    }
  };
}

function wireCommon() {
  app.querySelectorAll('.nav-tab').forEach(b => b.onclick = () => {
    const tab = b.dataset.tab;
    activeTab = tab; render();   // posting is free — no paywall
    if (tab === 'dashboard' || tab === 'profile') syncCounts();   // pull fresh stats when opening
  });
  const lo = app.querySelector('#pf-logout');
  if (lo) lo.onclick = async () => { await sb.auth.signOut(); state.me = null; activeTab='feed'; render(); };
  const payoutCta = app.querySelector('.pf-payout-cta');
  if (payoutCta) payoutCta.onclick = () => { activeTab = 'settings'; render(); };
}

function wireFeed() {
  // don't count a creator's own views/watch/taps (prevents self-inflating stats & gaming the feed)
  const ownPost = (postId) => { const p = state.posts.find(x=>x.id===postId); return !!(state.me && p && p.creator_id === state.me.id); };

  const watchStart = {};
  const viewTimers = {};
  const countedView = new Set();   // one view per video per session
  async function flushWatch(postId) {
    if (!watchStart[postId]) return;
    const dt = Date.now() - watchStart[postId];
    delete watchStart[postId];
    if (dt > 200 && !ownPost(postId)) {
      const p = state.posts.find(x=>x.id===postId); if (p) p.watch_ms = (p.watch_ms||0)+dt;  // optimistic
      sb.rpc('add_watch', { p_post: postId, p_ms: dt }).then(({error}) => { if (error) console.warn('add_watch error', error); });
    }
  }
  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      const postId = e.target.dataset.post;
      const vid = e.target.querySelector('.sr-video');
      if (e.isIntersecting) {
        if (vid) { vid.muted = feedMuted; vid.play().catch(()=>{}); }
        if (!watchStart[postId]) watchStart[postId] = Date.now();
        // count a view only after 2s of real watching (filters scroll-bys & most bots)
        if (!countedView.has(postId) && !ownPost(postId) && !viewTimers[postId]) {
          viewTimers[postId] = setTimeout(() => {
            delete viewTimers[postId];
            countedView.add(postId);
            const p = state.posts.find(x=>x.id===postId); if (p) p.views = (p.views||0)+1;
            sb.rpc('increment_view', { p_post: postId }).then(({error}) => { if (error) console.warn('increment_view error', error); });
          }, 2000);
        }
      } else {
        if (vid) vid.pause();
        flushWatch(postId);
        if (viewTimers[postId]) { clearTimeout(viewTimers[postId]); delete viewTimers[postId]; }
      }
    });
  }, { threshold: 0.6 });
  app.querySelectorAll('[data-post]').forEach(el => io.observe(el));

  // Reliably start the video that's in view on first load (don't wait for a scroll/tap).
  function playVisible() {
    const mid = window.innerHeight * 0.5;
    for (const el of app.querySelectorAll('[data-post]')) {
      const r = el.getBoundingClientRect();
      if (r.top <= mid && r.bottom >= mid) {
        const v = el.querySelector('.sr-video');
        if (v) { v.muted = feedMuted; v.play().catch(() => {}); }
        break;
      }
    }
  }
  // if we arrived here by tapping a specific video, jump straight to it
  if (state.feedFocusId) {
    const t = app.querySelector(`[data-post="${state.feedFocusId}"]`);
    state.feedFocusId = null;
    if (t) t.scrollIntoView();
  }
  playVisible();
  setTimeout(playVisible, 250);   // retry once after layout settles
  const unlock = () => { playVisible(); document.removeEventListener('pointerdown', unlock); };
  document.addEventListener('pointerdown', unlock, { once: true });   // unlock autoplay on first touch

  // mute / unmute (tap the speaker icon OR the video)
  function applyMute() {
    app.querySelectorAll('.sr-video').forEach(v => v.muted = feedMuted);
    app.querySelectorAll('.sr-mute').forEach(b => b.textContent = feedMuted ? '🔇' : '🔊');
  }
  applyMute();
  const toggleMute = (e) => { if (e) e.stopPropagation(); feedMuted = !feedMuted; applyMute(); };
  app.querySelectorAll('.sr-mute').forEach(b => b.onclick = toggleMute);
  app.querySelectorAll('.sr-video').forEach(v => v.onclick = () => toggleMute());

  // tap a creator's name/avatar -> open their profile
  app.querySelectorAll('.sr-creator').forEach(b => b.onclick = (e) => { e.stopPropagation(); openCreator(b.dataset.creator); });

  // like / comment / save / share
  app.querySelectorAll('.sr-like').forEach(b => b.onclick = (e) => { e.stopPropagation(); toggleLike(b.dataset.post); });
  app.querySelectorAll('.sr-save').forEach(b => b.onclick = (e) => { e.stopPropagation(); toggleSave(b.dataset.post); });
  app.querySelectorAll('.sr-comment').forEach(b => b.onclick = (e) => { e.stopPropagation(); openComments(b.dataset.post); });
  app.querySelectorAll('.sr-share').forEach(b => b.onclick = (e) => { e.stopPropagation(); shareVideo(b.dataset.post); });

  app.querySelectorAll('.sr-buy').forEach(b => b.onclick = () => {
    const prodId = b.dataset.prod;
    const postId = b.closest('[data-post]')?.dataset.post;
    if (!ownPost(postId)) {   // your own taps don't count
      sb.rpc('increment_tap', { p_product: prodId }).then(({error}) => { if (error) console.warn('increment_tap error', error); });
      const p = state.posts.find(x => x.id === postId);
      if (p) (p.products||[]).forEach(pr => { if (pr.id===prodId) pr.clicks=(pr.clicks||0)+1; });
    }
    if (b.dataset.link) {
      const p = state.posts.find(x => x.id === postId);
      const subid = p?.creator_id || 'unknown';   // creator tag (cuid) so Sovrn attributes the sale to the right creator
      window.open(wrapAffiliate(b.dataset.link, subid), '_blank', 'noopener');
    }
  });
}

/* ---------- inline AI moderation (grab a few frames, check them fast) ---------- */
function seekTo(v, t) {
  return new Promise((resolve) => {
    const done = () => { v.removeEventListener('seeked', done); resolve(); };
    v.addEventListener('seeked', done);
    try { v.currentTime = Math.max(0, Math.min(t, (v.duration || 1) - 0.05)); } catch { resolve(); }
  });
}
async function extractFrames(file) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.src = URL.createObjectURL(file);
    let settled = false;
    const fail = () => { if (!settled) { settled = true; resolve([]); } };
    v.addEventListener('error', fail);
    setTimeout(fail, 8000);   // never hang the publish button
    v.addEventListener('loadeddata', async () => {
      try {
        const dur = (v.duration && isFinite(v.duration)) ? v.duration : 1;
        const maxW = 512;
        const scale = v.videoWidth > maxW ? maxW / v.videoWidth : 1;
        const canvas = document.createElement('canvas');
        canvas.width = Math.round((v.videoWidth || 320) * scale);
        canvas.height = Math.round((v.videoHeight || 240) * scale);
        const ctx = canvas.getContext('2d');
        const frames = [];
        for (const t of [dur * 0.1, dur * 0.5, dur * 0.9]) {
          await seekTo(v, t);
          ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
          frames.push(canvas.toDataURL('image/jpeg', 0.7));
        }
        settled = true; resolve(frames);
      } catch { fail(); }
    });
  });
}
function dataUrlToBlob(dataUrl) {
  const [meta, b64] = dataUrl.split(',');
  const mime = (meta.match(/:(.*?);/) || [, 'image/jpeg'])[1];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// Free, in-browser AI moderation via NSFW.js (no API key, no payment).
// Loaded lazily on first publish so it doesn't slow page load.
let _nsfwModel = null;
function _loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('failed to load ' + src));
    document.head.appendChild(s);
  });
}
async function _ensureNsfw() {
  if (_nsfwModel) return _nsfwModel;
  if (!window.tf) await _loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js');
  if (!window.nsfwjs) await _loadScript('https://cdn.jsdelivr.net/npm/nsfwjs@4.2.1/dist/nsfwjs.min.js');
  _nsfwModel = await window.nsfwjs.load();   // downloads the model (~a few MB) once per session
  return _nsfwModel;
}
function _loadImg(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
}
async function moderate(frames) {
  if (!frames || !frames.length) return { allow: true };
  try {
    const model = await _ensureNsfw();
    let worst = 0;
    for (const f of frames.slice(0, 3)) {
      const img = await _loadImg(f);
      const preds = await model.classify(img);
      const m = Object.fromEntries(preds.map(p => [p.className, p.probability]));
      const explicit = (m.Porn || 0) + (m.Hentai || 0);   // 'Sexy' (bikini/swimwear) is NOT blocked
      if (explicit > worst) worst = explicit;
    }
    if (worst > 0.6) {
      return { allow: false, reason: "This video looks like it contains explicit content, which isn't allowed. Swimwear and bikini are fine — nudity and sexual content are not." };
    }
    return { allow: true, score: worst };
  } catch (e) {
    console.warn('moderation skipped (model failed to load)', e);
    return { allow: true, skipped: true };   // never hard-block on a technical failure
  }
}

/* ---------- social actions ---------- */
async function toggleLike(postId) {
  if (!state.me) return;
  const liked = state.myLikes.has(postId);
  const p = state.posts.find(x => x.id === postId);
  if (liked) { state.myLikes.delete(postId); if (p?.likes?.[0]) p.likes[0].count = Math.max(0, (p.likes[0].count||0) - 1); }
  else { state.myLikes.add(postId); if (p?.likes?.[0]) p.likes[0].count = (p.likes[0].count||0) + 1; else if (p) p.likes = [{ count: 1 }]; }
  app.querySelectorAll(`.sr-like[data-post="${postId}"]`).forEach(btn => {
    btn.querySelector('.sr-like-icon').textContent = state.myLikes.has(postId) ? '❤️' : '🤍';
    btn.querySelector('.sr-like-count').textContent = likeCountOf(p);
  });
  if (liked) await sb.from('likes').delete().eq('user_id', state.me.id).eq('post_id', postId);
  else await sb.from('likes').insert({ user_id: state.me.id, post_id: postId });
}

async function toggleSave(postId) {
  if (!state.me) return;
  const saved = state.mySaves.has(postId);
  if (saved) state.mySaves.delete(postId); else state.mySaves.add(postId);
  const now = state.mySaves.has(postId);
  app.querySelectorAll(`.sr-save[data-post="${postId}"]`).forEach(btn => {
    const lbl = btn.querySelector('.sr-save-label');
    lbl.textContent = now ? 'Saved' : 'Save';
    lbl.className = 'sr-save-label text-xs font-semibold drop-shadow ' + (now ? 'text-brand-500' : '');
  });
  if (saved) await sb.from('saves').delete().eq('user_id', state.me.id).eq('post_id', postId);
  else await sb.from('saves').insert({ user_id: state.me.id, post_id: postId });
}

async function shareVideo(postId) {
  const url = `${location.origin}${location.pathname}?v=${postId}`;
  try {
    if (navigator.share) await navigator.share({ title: 'Check out this video on ShopReel', url });
    else { await navigator.clipboard.writeText(url); alert('Link copied!'); }
    const p = state.posts.find(x => x.id === postId); if (p) p.shares = (p.shares || 0) + 1;  // count the share
    sb.rpc('increment_share', { p_post: postId }).then(({error}) => { if (error) console.warn('increment_share error', error); });
  } catch (_) { /* user cancelled — don't count */ }
}

async function openComments(postId) {
  const wrap = document.createElement('div');
  wrap.className = 'absolute inset-0 z-40 flex flex-col justify-end';
  wrap.innerHTML = `
    <div class="cm-backdrop absolute inset-0 bg-black/50"></div>
    <div class="relative bg-ink-900 rounded-t-2xl h-[65%] flex flex-col">
      <div class="p-4 border-b border-white/10 flex items-center justify-between">
        <span class="font-bold">Comments</span>
        <button class="cm-close text-white/50 text-xl">✕</button>
      </div>
      <div class="cm-list flex-1 overflow-y-auto p-4 space-y-3 text-sm">Loading…</div>
      <div class="p-3 border-t border-white/10 flex gap-2 safe-bottom">
        <input class="cm-input flex-1 px-3 py-2 rounded-full bg-white/10 outline-none text-sm" placeholder="Add a comment…" maxlength="300" />
        <button class="cm-send bg-brand-600 px-4 rounded-full font-bold text-sm">Send</button>
      </div>
    </div>`;
  app.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.querySelector('.cm-close').onclick = close;
  wrap.querySelector('.cm-backdrop').onclick = close;
  const listEl = wrap.querySelector('.cm-list');

  async function load() {
    const { data } = await sb.from('comments').select('*').eq('post_id', postId).order('created_at', { ascending: true });
    listEl.innerHTML = (data && data.length)
      ? data.map(c => `<div><span class="font-bold">@${esc(c.handle)}</span> <span class="text-white/80">${esc(c.text)}</span></div>`).join('')
      : '<p class="text-white/40 text-center mt-6">No comments yet. Be the first! 💬</p>';
    listEl.scrollTop = listEl.scrollHeight;
  }
  await load();

  const send = async () => {
    const inp = wrap.querySelector('.cm-input');
    const text = inp.value.trim();
    if (!text || !state.me) return;
    inp.value = '';
    const { error } = await sb.from('comments').insert({ post_id: postId, user_id: state.me.id, handle: state.me.handle, text });
    if (error) { alert(error.message); return; }
    const p = state.posts.find(x => x.id === postId);
    if (p) { if (p.comments?.[0]) p.comments[0].count++; else p.comments = [{ count: 1 }]; }
    const badge = app.querySelector(`.cm-count[data-post="${postId}"]`);
    if (badge && p) badge.textContent = commentCountOf(p);
    await load();
  };
  wrap.querySelector('.cm-send').onclick = send;
  wrap.querySelector('.cm-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
}

function wireCreate() {
  let vertical = loadDraft().vertical || 'beauty';
  const list = app.querySelector('#cr-products');

  function snapshot() {
    saveDraft({
      url: app.querySelector('#cr-url').value,
      caption: app.querySelector('#cr-caption').value,
      vertical,
      products: [...list.querySelectorAll('.cr-prod')].map(row => ({
        title: row.querySelector('.cr-p-title').value,
        price: row.querySelector('.cr-p-price').value,
        image: row.querySelector('.cr-p-image').value,
        link:  row.querySelector('.cr-p-link').value
      }))
    });
  }

  app.querySelectorAll('.cr-v').forEach(b => b.onclick = () => {
    vertical = b.dataset.v;
    app.querySelectorAll('.cr-v').forEach(x => x.className = 'cr-v px-3 py-2 rounded-full border text-sm border-white/20');
    b.className = 'cr-v px-3 py-2 rounded-full border text-sm bg-brand-600 text-white border-brand-600';
    snapshot();
  });

  const fileLabel = app.querySelector('#cr-file-label');
  const checkDuration = (file) => new Promise((resolve) => {
    const v = document.createElement('video'); v.preload = 'metadata';
    v.onloadedmetadata = () => { const d = v.duration; URL.revokeObjectURL(v.src); resolve(d); };
    v.onerror = () => resolve(null);
    v.src = URL.createObjectURL(file);
  });
  const onPick = async (input) => {
    const file = input.files && input.files[0];
    if (!file) return;
    const dur = await checkDuration(file);
    if (dur && dur > 122) {   // 2-minute limit (+2s buffer)
      createFileObj = null; input.value = '';
      fileLabel.textContent = '⚠️ That video is longer than 2 minutes — please pick a shorter one.';
      fileLabel.className = 'text-center text-sm mt-2 text-red-400';
      return;
    }
    createFileObj = file;
    fileLabel.textContent = '✅ ' + file.name + (dur ? ` · ${Math.round(dur)}s` : '');
    fileLabel.className = 'text-center text-sm mt-2 text-green-400';
  };
  app.querySelector('#cr-record').onchange = (e) => onPick(e.target);
  app.querySelector('#cr-pick').onchange = (e) => onPick(e.target);

  // discard / reset the whole create form
  app.querySelector('#cr-discard').onclick = () => {
    const hasContent = !!createFileObj
      || app.querySelector('#cr-url').value.trim()
      || app.querySelector('#cr-caption').value.trim()
      || [...app.querySelectorAll('.cr-prod')].some(r => r.querySelector('.cr-p-title').value.trim() || r.querySelector('.cr-p-link').value.trim());
    if (hasContent && !confirm('Discard this video and start over? Your current upload and details will be cleared.')) return;
    clearDraft();           // wipes saved draft + the selected video
    render();               // re-render a fresh, empty Create screen
  };

  // save text fields as the user types
  app.querySelector('#cr-form').addEventListener('input', snapshot);

  const bindDel = (row) => row.querySelector('.cr-del-prod').onclick = () => { row.remove(); snapshot(); };
  list.querySelectorAll('.cr-prod').forEach(bindDel);
  app.querySelector('#cr-add-prod').onclick = () => {
    list.insertAdjacentHTML('beforeend', ProductRow(list.children.length));
    bindDel(list.lastElementChild);
    snapshot();
  };

  app.querySelector('#cr-publish').onclick = async () => {
    const msg = app.querySelector('#cr-msg');
    const setErr = (t) => { msg.className='text-center text-sm h-4 text-red-400'; msg.textContent=t; };
    const url = app.querySelector('#cr-url').value.trim();
    const caption = app.querySelector('#cr-caption').value.trim();
    if (!createFileObj && !url) return setErr('Add a video file or URL.');

    const products = [...list.querySelectorAll('.cr-prod')].map((row,i) => ({
      title: row.querySelector('.cr-p-title').value.trim(),
      price: parseFloat(row.querySelector('.cr-p-price').value) || 0,
      image: row.querySelector('.cr-p-image').value.trim(),
      link: row.querySelector('.cr-p-link').value.trim(),
      position: i
    })).filter(p => p.title && p.link);
    if (!products.length) return setErr('Add at least one product with a name + affiliate link.');

    const setOk = (t) => { msg.className='text-center text-sm h-4 text-white/60'; msg.textContent=t; };

    // 1) Inline AI safety check — runs now so there's no "pending" wait after publishing.
    let frames = [];
    if (createFileObj) {
      setOk('🔍 Checking your video…');
      const t0 = Date.now();
      frames = await extractFrames(createFileObj);
      const verdict = await moderate(frames);
      const elapsed = Date.now() - t0;
      if (elapsed < 900) await new Promise(r => setTimeout(r, 900 - elapsed)); // keep the step visible
      if (!verdict.allow) return setErr(verdict.reason || 'This video violates our content policy.');
    }
    setOk('Uploading…');

    let videoUrl = url, posterUrl = null;
    if (createFileObj) {
      const stamp = Date.now();
      const ext = (createFileObj.name.split('.').pop() || 'mp4').toLowerCase();
      const path = `${state.me.id}/${stamp}.${ext}`;
      const { error: upErr } = await sb.storage.from('videos').upload(path, createFileObj, { contentType: createFileObj.type });
      if (upErr) return setErr('Video upload failed: ' + upErr.message);
      videoUrl = sb.storage.from('videos').getPublicUrl(path).data.publicUrl;
      // poster thumbnail (first frame): shows instantly while video loads + fixes black grid thumbnails
      if (frames[0]) {
        try {
          const posterPath = `${state.me.id}/poster-${stamp}.jpg`;
          await sb.storage.from('videos').upload(posterPath, dataUrlToBlob(frames[0]), { contentType: 'image/jpeg', upsert: true });
          posterUrl = sb.storage.from('videos').getPublicUrl(posterPath).data.publicUrl;
        } catch (_) { /* poster is optional */ }
      }
    }

    const { data: post, error: pErr } = await sb.from('posts')
      .insert({ creator_id: state.me.id, handle: state.me.handle, vertical, caption, video_url: videoUrl, poster_url: posterUrl })
      .select().single();
    if (pErr) return setErr('Could not save post: ' + pErr.message);

    const { error: prErr } = await sb.from('products').insert(products.map(p => ({ ...p, post_id: post.id })));
    if (prErr) return setErr('Saved video, but products failed: ' + prErr.message);

    clearDraft();
    msg.className='text-center text-sm h-4 text-green-400'; msg.textContent='✅ Published!';
    await refreshPosts();
    state.feedFocusId = post.id;   // jump the feed to the video we just posted
    setTimeout(() => { activeTab = 'feed'; render(); }, 500);
  };
}

function wireSubscribe() {
  app.querySelector('.sub-close').onclick = () => { activeTab = 'feed'; render(); };
  app.querySelectorAll('.sub-pick').forEach(b => b.onclick = async () => {
    const planId = b.dataset.plan;
    b.textContent = 'Please wait…'; b.disabled = true;
    if (STRIPE_READY) {
      try {
        const res = await fetch('/api/create-checkout-session', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan: planId, userId: state.me.id, email: state.me.email })
        });
        const { url, error } = await res.json();
        if (url) { window.location.href = url; return; }
        alert('Payment error: ' + (error || 'unknown'));
      } catch (e) { alert('Payment error: ' + e.message); }
      b.disabled = false;
    } else {
      // demo mode (no Stripe yet): mark the plan directly so the app is testable
      await sb.from('profiles').update({ plan: planId, plan_since: new Date().toISOString() }).eq('id', state.me.id);
      await reloadMe(); activeTab = 'create'; render();
    }
  });
}

function wireProfile() {
  const gear = app.querySelector('.pf-settings');
  if (gear) gear.onclick = () => { activeTab = 'settings'; render(); };
  app.querySelectorAll('.pf-vid').forEach(b => b.onclick = () => openPostInFeed(b.dataset.post));
  app.querySelectorAll('.pf-del-vid').forEach(b => b.onclick = async (e) => {
    e.stopPropagation();
    if (!confirm('Delete this video? This cannot be undone.')) return;
    b.textContent = '…'; b.disabled = true;
    const err = await deletePost(b.dataset.post, b.dataset.url);
    if (err) { alert('Could not delete: ' + err.message); b.textContent = '🗑️'; b.disabled = false; return; }
    await refreshPosts(); render();
  });
  const cta = app.querySelector('.pf-create-cta');
  if (cta) cta.onclick = () => { activeTab = 'create'; render(); };
  const add = app.querySelector('#pf-add-link');
  if (add) add.onclick = async () => {
    const label = app.querySelector('#pf-link-label').value.trim();
    let url = app.querySelector('#pf-link-url').value.trim();
    const msg = app.querySelector('#pf-link-msg');
    if (!label || !url) { msg.textContent = 'Add both a label and a URL.'; return; }
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    const links = (state.me.links || []).concat({ id: Math.random().toString(36).slice(2,9), label, url });
    await sb.from('profiles').update({ links }).eq('id', state.me.id);
    state.me.links = links; render();
  };
  app.querySelectorAll('.pf-del-link').forEach(b => b.onclick = async () => {
    const links = (state.me.links || []).filter(l => l.id !== b.dataset.id);
    await sb.from('profiles').update({ links }).eq('id', state.me.id);
    state.me.links = links; render();
  });
}

function wireSettings() {
  let vertical = state.me.vertical;
  app.querySelector('.set-back').onclick = () => { activeTab = 'profile'; render(); };

  const av = app.querySelector('#set-avatar');
  if (av) av.onchange = async () => {
    const file = av.files[0]; if (!file) return;
    const amsg = app.querySelector('#set-avatar-msg');
    amsg.textContent = 'Uploading photo…';
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
    const path = `avatars/${state.me.id}-${Date.now()}.${ext}`;
    const { error: upErr } = await sb.storage.from('videos').upload(path, file, { contentType: file.type, upsert: true });
    if (upErr) { amsg.textContent = 'Upload failed: ' + upErr.message; return; }
    const url = sb.storage.from('videos').getPublicUrl(path).data.publicUrl;
    const { error } = await sb.from('profiles').update({ avatar_url: url }).eq('id', state.me.id);
    if (error) { amsg.textContent = error.message; return; }
    state.me.avatar_url = url;
    await refreshPosts();   // so your avatar shows on your videos in the feed too
    render();
  };
  app.querySelectorAll('.set-v').forEach(b => b.onclick = () => {
    vertical = b.dataset.v;
    app.querySelectorAll('.set-v').forEach(x => x.className = 'set-v px-3 py-2 rounded-full border text-sm border-white/20');
    b.className = 'set-v px-3 py-2 rounded-full border text-sm bg-brand-600 text-white border-brand-600';
  });
  app.querySelector('#set-save').onclick = async () => {
    const handle = app.querySelector('#set-handle').value.trim();
    const msg = app.querySelector('#set-msg');
    if (!handle) { msg.className='text-center text-sm h-4 text-red-400'; msg.textContent='Handle can’t be empty.'; return; }
    msg.className='text-center text-sm h-4 text-white/60'; msg.textContent='Saving…';
    const oldHandle = state.me.handle;
    const { error } = await sb.from('profiles').update({ handle, vertical }).eq('id', state.me.id);
    if (error) { msg.className='text-center text-sm h-4 text-red-400'; msg.textContent=error.message; return; }
    if (handle !== oldHandle) await sb.from('posts').update({ handle }).eq('creator_id', state.me.id);
    // save payout details
    await sb.from('payout_accounts').upsert({
      user_id: state.me.id,
      paypal_email: app.querySelector('#set-paypal').value.trim(),
      upi: app.querySelector('#set-upi').value.trim(),
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });
    await Promise.all([reloadMe(), refreshPosts(), loadPayout()]);
    msg.className='text-center text-sm h-4 text-green-400'; msg.textContent='✅ Saved!';
    setTimeout(() => { activeTab = 'profile'; render(); }, 500);
  };
}

/* ---------- boot ---------- */
boot();

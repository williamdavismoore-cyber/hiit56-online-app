/* HIIT56 CP12 — static preview renderer (no backend/auth yet)
   Notes:
   - Member vs Business vs Guest is currently a demo role flag stored in localStorage.
   - Public previews are teaser-limited. Member pages show full lists.
*/

const qs = (sel, el=document) => el.querySelector(sel);
const qsa = (sel, el=document) => Array.from(el.querySelectorAll(sel));
const fmt = (n) => new Intl.NumberFormat().format(Number(n||0));

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const clampInt = (value, min, max, fallback = 1) => {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
};
const fmtTime = (sec) => {
  const s = Math.max(0, Math.floor(Number(sec||0)));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m.toString().padStart(2,'0')}:${r.toString().padStart(2,'0')}`;
};

const BEEP_KEY = 'hiit56_beep_volume'; // stored as 0..1 float
function getBeepVolume(){
  const raw = localStorage.getItem(BEEP_KEY);
  const v = raw === null ? 0.7 : Number(raw);
  return clamp(isFinite(v) ? v : 0.7, 0, 1);
}
function setBeepVolume(v){
  localStorage.setItem(BEEP_KEY, String(clamp(Number(v)||0, 0, 1)));
}

let _audioCtx = null;
function ensureAudio(){
  if(_audioCtx) return _audioCtx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if(!AC) return null;
  _audioCtx = new AC();
  return _audioCtx;
}

function unlockAudio(){
  const ctx = ensureAudio();
  if(!ctx) return;
  if(ctx.state === 'suspended'){
    ctx.resume().catch(()=>{});
  }
}
// Unlock audio on first user gesture (mobile Safari/Chrome autoplay rules)
window.addEventListener('pointerdown', unlockAudio, {once:true});
window.addEventListener('touchstart', unlockAudio, {once:true});


function beep({freq=880, duration=0.085, at=null, volume=null}={}){
  const ctx = ensureAudio();
  if(!ctx) return;
  const t0 = at ?? (ctx.currentTime + 0.01);
  const vol = volume ?? getBeepVolume();

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, t0);

  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.linearRampToValueAtTime(vol, t0 + 0.01);
  gain.gain.linearRampToValueAtTime(0.0001, t0 + duration);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

function beepPattern(name){
  const ctx = ensureAudio();
  if(!ctx) return;

  const base = ctx.currentTime + 0.02;
  const v = getBeepVolume();

  const patterns = {
    start:   [{f:880, d:0.10, t:0.00}],
    work:    [{f:880, d:0.08, t:0.00}],
    rest:    [{f:660, d:0.08, t:0.00},{f:660, d:0.08, t:0.13}],
    move_a:  [{f:740, d:0.08, t:0.00}],
    move_b:  [{f:520, d:0.08, t:0.00}],
    station: [{f:440, d:0.08, t:0.00},{f:440, d:0.08, t:0.13},{f:440, d:0.08, t:0.26}],
    complete:[{f:990, d:0.14, t:0.00},{f:990, d:0.14, t:0.18}],
  };

  const p = patterns[name] || patterns.work;
  p.forEach(e => beep({freq:e.f, duration:e.d, at:base + e.t, volume:v}));
}

// Wake Lock (keep screen awake during timers) — best-effort (not supported everywhere)
let _wakeLock = null;
let _wakeLockWanted = false;

async function setWakeLockWanted(on){
  _wakeLockWanted = !!on;
  if(!_wakeLockWanted){
    try{ if(_wakeLock) await _wakeLock.release(); }catch(e){}
    _wakeLock = null;
    return false;
  }
  if(!('wakeLock' in navigator)) return false;
  try{
    _wakeLock = await navigator.wakeLock.request('screen');
    return true;
  }catch(e){
    _wakeLock = null;
    return false;
  }
}

document.addEventListener('visibilitychange', ()=>{
  // Wake locks often release when backgrounded; re-request on return.
  if(_wakeLockWanted && document.visibilityState === 'visible'){
    setWakeLockWanted(true);
  }
});


// Timing engine (performance.now truth; RAF for UI)
function computeTotalSec(segments){
  return (segments||[]).reduce((a,s)=>a + Number(s.duration_sec||0), 0);
}

function cloneSegments(segments){
  return (segments||[]).map(s => ({
    kind: s.kind,
    duration_sec: Number(s.duration_sec||0),
    meta: s.meta ? JSON.parse(JSON.stringify(s.meta)) : {}
  }));
}

function minDurationForKind(kind){
  // conservative minima so time-cap reductions don't go negative/janky
  if(kind === 'WORK') return 10;
  if(kind === 'REST') return 5;
  if(kind === 'MOVE_TRANSITION_A' || kind === 'MOVE_TRANSITION_B') return 3;
  if(kind === 'STATION_STAGE_TRANSITION') return 5;
  return 1;
}

function poolAllowsKind(pool, kind){
  if(pool === 'all') return true;
  if(pool === 'work') return kind === 'WORK';
  if(pool === 'rest') return kind === 'REST';
  if(pool === 'transitions') return (kind === 'MOVE_TRANSITION_A' || kind === 'MOVE_TRANSITION_B' || kind === 'STATION_STAGE_TRANSITION');
  return false;
}

function applyTimeCap(segments, capSec, pool, opts={}){
  const segs = cloneSegments(segments);
  const total = computeTotalSec(segs);
  const target = Math.max(1, Math.floor(Number(capSec||0)));
  let delta = target - total; // + means add time, - means reduce

  const idx = segs.map((s,i)=> poolAllowsKind(pool, s.kind) ? i : -1).filter(i=>i>=0);

  if(idx.length === 0){
    return {segments: segs, note: 'No eligible segments for this cap pool.', total_before: total, total_after: total};
  }

  if(delta === 0){
    return {segments: segs, note: 'Already matches cap.', total_before: total, total_after: total};
  }

  if(delta > 0){
    const under = String(opts?.under_strategy || 'adjust');
    if(under === 'finisher'){
      // Add a finisher block at the end to hit the cap exactly.
      // If a finisher_builder is supplied, it can return a multi-segment 'cap-filler' sequence.
      const builder = opts?.finisher_builder;
      if(typeof builder === 'function'){
        const extra = builder(delta);
        if(Array.isArray(extra) && extra.length){
          extra.forEach(s=>{ if(s && typeof s.duration_sec==='number') s.duration_sec = Math.max(1, Math.floor(s.duration_sec)); });
          segs.push(...extra);
          const after = computeTotalSec(segs);
          return {segments: segs, note: `Added cap-filler ${fmtTime(after-total)} to hit cap.`, total_before: total, total_after: after};
        }
      }
      const finMeta = Object.assign({}, (opts?.finisher_meta || {}), {
        move_name: (opts?.finisher_name || 'Finisher'),
        rest_type: 'Finisher'
      });
      segs.push({kind:'WORK', duration_sec: Math.max(1, delta), meta: finMeta});
      const after = computeTotalSec(segs);
      return {segments: segs, note: `Added finisher ${fmtTime(after-total)} to hit cap.`, total_before: total, total_after: after};
    }

    // Default: spread added seconds across eligible segments
    const per = Math.floor(delta / idx.length);
    let rem = delta - per*idx.length;
    idx.forEach(i => { segs[i].duration_sec += per; });
    for(let k=0; k<idx.length && rem>0; k++){
      segs[idx[k]].duration_sec += 1;
      rem -= 1;
    }
    const after = computeTotalSec(segs);
    return {segments: segs, note: `Added ${fmtTime(after-total)} across ${idx.length} segments (${pool}).`, total_before: total, total_after: after};
  }

  // delta < 0, need to reduce
  let need = -delta;
  let active = idx.slice();
  // compute maximum reducible
  const maxReducible = active.reduce((a,i)=> a + Math.max(0, segs[i].duration_sec - minDurationForKind(segs[i].kind)), 0);
  if(maxReducible <= 0){
    return {segments: segs, note: 'Nothing reducible in selected pool.', total_before: total, total_after: total};
  }

  if(maxReducible < need){
    // reduce as much as possible (hit minima) but can't reach cap
    active.forEach(i => { segs[i].duration_sec = minDurationForKind(segs[i].kind); });
    const after = computeTotalSec(segs);
    return {segments: segs, note: `Could not reach cap: reduced ${fmtTime(total-after)} but hit minimum durations.`, total_before: total, total_after: after};
  }

  while(need > 0 && active.length){
    const per = Math.floor(need / active.length) || 1;
    const next = [];
    for(const i of active){
      const min = minDurationForKind(segs[i].kind);
      const reducible = Math.max(0, segs[i].duration_sec - min);
      const dec = Math.min(reducible, per, need);
      segs[i].duration_sec -= dec;
      need -= dec;
      if(segs[i].duration_sec > min) next.push(i);
      if(need <= 0) break;
    }
    active = next;
  }

  const after = computeTotalSec(segs);
  return {segments: segs, note: `Reduced ${fmtTime(total-after)} across ${idx.length} segments (${pool}).`, total_before: total, total_after: after};
}

class HiitTimerEngine{
  constructor(segments, {onTick=null, onSegment=null, onComplete=null, timeScale=1}={}){
    this.segments = cloneSegments(segments);
    this.onTick = onTick;
    this.onSegment = onSegment;
    this.onComplete = onComplete;
    this.timeScale = Number(timeScale||1);

    this._running = false;
    this._raf = null;
    this._startPerf = 0;
    this._startElapsed = 0;
    this._elapsed = 0;
    this._idx = 0;

    this._starts = [0];
    for(const s of this.segments){
      this._starts.push(this._starts[this._starts.length-1] + Number(s.duration_sec||0));
    }
    this.total = this._starts[this._starts.length-1] || 0;

    // bind for RAF callbacks (avoid class field syntax for iOS Safari compatibility)
    this._tick = this._tick.bind(this);
  }

  currentIndex(){
    return this._idx;
  }
  currentSegment(){
    return this.segments[this._idx] || null;
  }
  isRunning(){
    return this._running;
  }

  _tick(){
    if(!this._running) return;

    const now = performance.now();
    this._elapsed = this._startElapsed + ((now - this._startPerf) / 1000) * this.timeScale;

    if(this._elapsed >= this.total){
      this._elapsed = this.total;
      this._running = false;
      if(this.onTick) this.onTick({elapsed:this._elapsed, total:this.total, idx:this._idx, remaining:0, segRemaining:0, segElapsed:0});
      if(this.onComplete) this.onComplete();
      return;
    }

    // advance segment index (monotonic forward)
    while(this._idx < this.segments.length-1 && this._elapsed >= this._starts[this._idx+1]){
      this._idx += 1;
      if(this.onSegment) this.onSegment({idx:this._idx, segment:this.currentSegment()});
    }

    const segStart = this._starts[this._idx] || 0;
    const seg = this.currentSegment();
    const segElapsed = this._elapsed - segStart;
    const segRemaining = Math.max(0, Number(seg.duration_sec||0) - segElapsed);
    const remaining = Math.max(0, this.total - this._elapsed);

    if(this.onTick) this.onTick({elapsed:this._elapsed, total:this.total, idx:this._idx, remaining, segRemaining, segElapsed});

    this._raf = requestAnimationFrame(this._tick);
  }

  start(){
    if(this._running) return;
    this._running = true;
    this._startPerf = performance.now();
    this._startElapsed = this._elapsed;
    // fire initial segment callback
    if(this.onSegment) this.onSegment({idx:this._idx, segment:this.currentSegment(), initial:true});
    this._raf = requestAnimationFrame(this._tick);
  }

  pause(){
    if(!this._running) return;
    this._running = false;
    if(this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  toggle(){
    if(this._running) this.pause(); else this.start();
  }

  reset(){
    this.pause();
    this._elapsed = 0;
    this._idx = 0;
    if(this.onSegment) this.onSegment({idx:this._idx, segment:this.currentSegment(), initial:true});
    if(this.onTick) this.onTick({elapsed:0, total:this.total, idx:this._idx, remaining:this.total, segRemaining:Number(this.currentSegment()?.duration_sec||0), segElapsed:0});
  }

  skip(){
    // jump to next segment start
    if(this._idx >= this.segments.length-1){
      this._elapsed = this.total;
      return;
    }
    this._elapsed = this._starts[this._idx+1] || this.total;
    this._idx = Math.min(this._idx+1, this.segments.length-1);
    if(this.onSegment) this.onSegment({idx:this._idx, segment:this.currentSegment()});
  }
}

function kindLabel(kind){
  if(kind === 'WORK') return 'WORK';
  if(kind === 'REST') return 'REST';
  if(kind === 'MOVE_TRANSITION_A') return 'TRANSITION (A)';
  if(kind === 'MOVE_TRANSITION_B') return 'TRANSITION (B)';
  if(kind === 'STATION_STAGE_TRANSITION') return 'TRANSITION (STATION/STAGE)';
  return kind || '—';
}
function kindClass(kind){
  if(kind === 'WORK') return 'kind-work';
  if(kind === 'REST') return 'kind-rest';
  if(kind === 'MOVE_TRANSITION_A') return 'kind-move-a';
  if(kind === 'MOVE_TRANSITION_B') return 'kind-move-b';
  if(kind === 'STATION_STAGE_TRANSITION') return 'kind-station';
  return '';
}
function beepNameForKind(kind){
  if(kind === 'WORK') return 'work';
  if(kind === 'REST') return 'rest';
  if(kind === 'MOVE_TRANSITION_A') return 'move_a';
  if(kind === 'MOVE_TRANSITION_B') return 'move_b';
  if(kind === 'STATION_STAGE_TRANSITION') return 'station';
  return 'work';
}


function show(el, on=true){
  if(!el) return;
  el.style.display = on ? '' : 'none';
}

// Demo auth + tenancy (CP10)
// Roles: guest, member, biz_staff, biz_admin, super_admin
const ROLE_KEY = 'hiit56_role';
const TENANT_KEY = 'hiit56_tenant_slug';
const TENANT_NAME_KEY = 'hiit56_tenant_name';

// CP10 — demo identity + coupons/comps + tenant provisioning (localStorage until Supabase)
const EMAIL_KEY = 'hiit56_demo_email';
const CUSTOM_TENANTS_KEY = 'hiit56_custom_tenants';

const MEMBER_COUPONS_KEY = 'hiit56_coupons_member';
const BIZ_COUPONS_KEY = 'hiit56_coupons_biz';
const MEMBER_COUPON_APPLIED_KEY = 'hiit56_member_coupon_applied';
const BIZ_COUPON_APPLIED_PREFIX = 'hiit56_biz_coupon_applied_';

const MEMBER_COMPS_KEY = 'hiit56_comps_member';
const BIZ_COMPS_KEY = 'hiit56_comps_biz';

// Stripe checkout session persistence (CP18)
// We store the Checkout Session ID returned to /login.html on success (session_id={CHECKOUT_SESSION_ID}).
// This enables "Manage Billing" via Stripe Customer Portal even before Supabase is wired.
const STRIPE_SESSION_MEMBER_KEY = 'hiit56_stripe_checkout_session_member';
const STRIPE_SESSION_BIZ_PREFIX = 'hiit56_stripe_checkout_session_biz_';

function isStripeCheckoutSessionId(id){
  return /^cs_/.test(String(id||''));
}

function setMemberCheckoutSessionId(sessionId){
  const id = String(sessionId||'').trim();
  if(!isStripeCheckoutSessionId(id)) return;
  localStorage.setItem(STRIPE_SESSION_MEMBER_KEY, id);
}
function getMemberCheckoutSessionId(){
  return String(localStorage.getItem(STRIPE_SESSION_MEMBER_KEY) || '').trim();
}
function clearMemberCheckoutSessionId(){
  localStorage.removeItem(STRIPE_SESSION_MEMBER_KEY);
}

function setBizCheckoutSessionId(tenantSlug, sessionId){
  const t = String(tenantSlug||'').trim();
  const id = String(sessionId||'').trim();
  if(!t || !isStripeCheckoutSessionId(id)) return;
  localStorage.setItem(STRIPE_SESSION_BIZ_PREFIX + t, id);
}
function getBizCheckoutSessionId(tenantSlug){
  const t = String(tenantSlug||'').trim();
  if(!t) return '';
  return String(localStorage.getItem(STRIPE_SESSION_BIZ_PREFIX + t) || '').trim();
}
function clearBizCheckoutSessionId(tenantSlug){
  const t = String(tenantSlug||'').trim();
  if(!t) return;
  localStorage.removeItem(STRIPE_SESSION_BIZ_PREFIX + t);
}

async function openBillingPortal({scope='member'}={}){
  // scope: 'member' | 'biz'
  let cfg = null;
  try{ cfg = await loadJSON('/assets/data/stripe_public_test.json'); }catch(e){ cfg = null; }
  const endpoint = (cfg?.endpoints?.create_portal_session) ? cfg.endpoints.create_portal_session : '/api/stripe/create-portal-session';

  const origin = location.origin;
  const return_url = (scope === 'biz') ? `${origin}/biz/account/` : `${origin}/app/account/`;

  const session_id = (scope === 'biz')
    ? getBizCheckoutSessionId(getTenant())
    : getMemberCheckoutSessionId();

  if(!session_id){
    throw new Error('No checkout session stored yet. Complete checkout once, then return here to manage billing.');
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id, return_url })
  });

  let data = {};
  try{ data = await res.json(); }catch(e){ data = {}; }

  if(!res.ok || !data?.url){
    const msg = data?.error || `Portal session error (${res.status}).`;
    throw new Error(msg);
  }

  location.href = data.url;
}


function getRole(){
  return localStorage.getItem(ROLE_KEY) || 'guest';
}
function setRole(role){
  localStorage.setItem(ROLE_KEY, role);
}

function getTenant(){
  return localStorage.getItem(TENANT_KEY) || '';
}
function getTenantName(){
  return localStorage.getItem(TENANT_NAME_KEY) || '';
}
function setTenant({slug='', name=''}={}){
  if(!slug){
    localStorage.removeItem(TENANT_KEY);
    localStorage.removeItem(TENANT_NAME_KEY);
    return;
  }
  localStorage.setItem(TENANT_KEY, slug);
  localStorage.setItem(TENANT_NAME_KEY, name || slug);
}


// --- CP10 demo identity helpers ---
function getEmail(){
  return (localStorage.getItem(EMAIL_KEY) || '').trim();
}
function setEmail(email){
  const e = String(email || '').trim().toLowerCase();
  if(!e){ localStorage.removeItem(EMAIL_KEY); return; }
  localStorage.setItem(EMAIL_KEY, e);
}

function readJSON(key, fallback){
  try{
    const raw = localStorage.getItem(key);
    if(!raw) return fallback;
    return JSON.parse(raw);
  }catch(e){ return fallback; }
}
function writeJSON(key, value){
  localStorage.setItem(key, JSON.stringify(value));
}

// --- Timer templates (local prototype — Supabase later) ---
const MY_WORKOUTS_KEY = 'hiit56_member_my_workouts_v1';
function getMyWorkouts(){
  const arr = readJSON(MY_WORKOUTS_KEY, []);
  return Array.isArray(arr) ? arr : [];
}
function saveMyWorkouts(arr){
  writeJSON(MY_WORKOUTS_KEY, Array.isArray(arr) ? arr : []);
}
function getMyWorkoutById(id){
  const s = String(id||'').trim();
  if(!s) return null;
  return getMyWorkouts().find(w => String(w.id) === s) || null;
}
function upsertMyWorkout(workout){
  const w = Object.assign({}, workout || {});
  const id = String(w.id || '').trim();
  if(!id) return;
  const cur = getMyWorkouts();
  const next = cur.filter(x => String(x.id) !== id);
  next.unshift(w);
  saveMyWorkouts(next);
}
function deleteMyWorkout(id){
  const s = String(id||'').trim();
  if(!s) return;
  const next = getMyWorkouts().filter(w => String(w.id) !== s);
  saveMyWorkouts(next);
}

const BIZ_GYM_TEMPLATES_PREFIX = 'hiit56_biz_gym_templates_v1:';
const BIZ_GYM_MODS_PREFIX = 'hiit56_biz_gym_mods_v1:';

function isoDateLocal(){
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

function getBizGymTemplates(tenant){
  const key = `${BIZ_GYM_TEMPLATES_PREFIX}${tenant || 'global'}`;
  const arr = readJSON(key, []);
  return Array.isArray(arr) ? arr : [];
}
function saveBizGymTemplates(tenant, arr){
  const key = `${BIZ_GYM_TEMPLATES_PREFIX}${tenant || 'global'}`;
  writeJSON(key, Array.isArray(arr) ? arr : []);
}
function upsertBizGymTemplate(tenant, tpl){
  const t = Object.assign({}, tpl || {});
  const id = String(t.id || '').trim();
  if(!id) return;
  const cur = getBizGymTemplates(tenant);
  const next = cur.filter(x => String(x.id) !== id);
  next.unshift(t);
  saveBizGymTemplates(tenant, next);
}
function deleteBizGymTemplate(tenant, id){
  const s = String(id||'').trim();
  if(!s) return;
  const next = getBizGymTemplates(tenant).filter(x => String(x.id) !== s);
  saveBizGymTemplates(tenant, next);
}

function getBizGymModsToday(tenant){
  const key = `${BIZ_GYM_MODS_PREFIX}${tenant || 'global'}:${isoDateLocal()}`;
  const arr = readJSON(key, []);
  return Array.isArray(arr) ? arr : [];
}
function saveBizGymModsToday(tenant, arr){
  const key = `${BIZ_GYM_MODS_PREFIX}${tenant || 'global'}:${isoDateLocal()}`;
  writeJSON(key, Array.isArray(arr) ? arr : []);
}
function upsertBizGymModToday(tenant, mod){
  const t = Object.assign({}, mod || {});
  const id = String(t.id || '').trim();
  if(!id) return;
  const cur = getBizGymModsToday(tenant);
  const next = cur.filter(x => String(x.id) !== id);
  next.unshift(t);
  saveBizGymModsToday(tenant, next);
}


// --- CP10 custom tenants (localStorage) ---
function getCustomTenants(){
  const arr = readJSON(CUSTOM_TENANTS_KEY, []);
  return Array.isArray(arr) ? arr : [];
}
function saveCustomTenants(arr){
  writeJSON(CUSTOM_TENANTS_KEY, Array.isArray(arr) ? arr : []);
}
function upsertCustomTenant(t){
  const slug = String(t?.slug || '').trim();
  const name = String(t?.name || '').trim() || slug;
  if(!slug) return;
  const cur = getCustomTenants();
  const next = cur.filter(x => x.slug !== slug);
  next.unshift({slug, name, custom:true});
  saveCustomTenants(next);
}
function removeCustomTenant(slug){
  const s = String(slug||'').trim();
  if(!s) return;
  const next = getCustomTenants().filter(x => x.slug !== s);
  saveCustomTenants(next);
}

// --- CP10 coupons + comps (localStorage) ---
function normCode(code){
  return String(code||'').trim().toUpperCase();
}

function getCouponDefs(scope){
  const key = (scope === 'biz') ? BIZ_COUPONS_KEY : MEMBER_COUPONS_KEY;
  const arr = readJSON(key, []);
  return Array.isArray(arr) ? arr : [];
}
function saveCouponDefs(scope, arr){
  const key = (scope === 'biz') ? BIZ_COUPONS_KEY : MEMBER_COUPONS_KEY;
  writeJSON(key, Array.isArray(arr) ? arr : []);
}
function upsertCoupon(scope, coupon){
  const code = normCode(coupon?.code);
  if(!code) return;
  const cur = getCouponDefs(scope);
  const next = cur.filter(c => normCode(c.code) !== code);
  next.unshift({
    code,
    note: String(coupon?.note || '').trim(),
    percent_off: Number(coupon?.percent_off || 0) || 0,
    amount_off: Number(coupon?.amount_off || 0) || 0,
    created_at: new Date().toISOString(),
  });
  saveCouponDefs(scope, next);
}
function deleteCoupon(scope, code){
  const c = normCode(code);
  const next = getCouponDefs(scope).filter(x => normCode(x.code) !== c);
  saveCouponDefs(scope, next);
}

function getAppliedCoupon(scope, tenantSlug=''){
  if(scope === 'biz'){
    const s = String(tenantSlug||getTenant()||'').trim();
    return normCode(localStorage.getItem(BIZ_COUPON_APPLIED_PREFIX + s) || '');
  }
  return normCode(localStorage.getItem(MEMBER_COUPON_APPLIED_KEY) || '');
}
function setAppliedCoupon(scope, code, tenantSlug=''){
  const c = normCode(code);
  if(scope === 'biz'){
    const s = String(tenantSlug||getTenant()||'').trim();
    if(!s) return;
    if(!c){ localStorage.removeItem(BIZ_COUPON_APPLIED_PREFIX + s); return; }
    localStorage.setItem(BIZ_COUPON_APPLIED_PREFIX + s, c);
    return;
  }
  if(!c){ localStorage.removeItem(MEMBER_COUPON_APPLIED_KEY); return; }
  localStorage.setItem(MEMBER_COUPON_APPLIED_KEY, c);
}

function parseISO(s){
  if(s === null) return null;
  if(!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
function isActiveUntil(expiresAt){
  if(expiresAt === null) return true; // forever
  const d = parseISO(expiresAt);
  if(!d) return false;
  return d.getTime() > Date.now();
}
function daysFromNow(days){
  const ms = Number(days||0) * 86400000;
  return new Date(Date.now() + ms).toISOString();
}

function getMemberComps(){
  const arr = readJSON(MEMBER_COMPS_KEY, []);
  return Array.isArray(arr) ? arr : [];
}
function saveMemberComps(arr){ writeJSON(MEMBER_COMPS_KEY, Array.isArray(arr)?arr:[]); }
function getBizComps(){
  const arr = readJSON(BIZ_COMPS_KEY, []);
  return Array.isArray(arr) ? arr : [];
}
function saveBizComps(arr){ writeJSON(BIZ_COMPS_KEY, Array.isArray(arr)?arr:[]); }

function grantMemberComp(email, {days=30, forever=false, note=''}={}){
  const e = String(email||'').trim().toLowerCase();
  if(!e) return;
  const expires_at = forever ? null : daysFromNow(days);
  const cur = getMemberComps().filter(x => String(x.email||'').toLowerCase() !== e);
  cur.unshift({email:e, expires_at, note:String(note||'').trim(), granted_at:new Date().toISOString()});
  saveMemberComps(cur);
}
function grantBizComp(tenantSlug, {days=30, forever=false, note=''}={}){
  const s = String(tenantSlug||'').trim();
  if(!s) return;
  const expires_at = forever ? null : daysFromNow(days);
  const cur = getBizComps().filter(x => String(x.tenant_slug||'') !== s);
  cur.unshift({tenant_slug:s, expires_at, note:String(note||'').trim(), granted_at:new Date().toISOString()});
  saveBizComps(cur);
}
function getActiveMemberComp(email){
  const e = String(email||getEmail()||'').trim().toLowerCase();
  if(!e) return null;
  const rec = getMemberComps().find(x => String(x.email||'').toLowerCase() === e);
  if(!rec) return null;
  return isActiveUntil(rec.expires_at) ? rec : null;
}
function getActiveBizComp(tenantSlug){
  const s = String(tenantSlug||getTenant()||'').trim();
  if(!s) return null;
  const rec = getBizComps().find(x => String(x.tenant_slug||'') === s);
  if(!rec) return null;
  return isActiveUntil(rec.expires_at) ? rec : null;
}
function revokeMemberComp(email){
  const e = String(email||'').trim().toLowerCase();
  if(!e) return;
  saveMemberComps(getMemberComps().filter(x => String(x.email||'').toLowerCase() !== e));
}
function revokeBizComp(tenantSlug){
  const s = String(tenantSlug||'').trim();
  if(!s) return;
  saveBizComps(getBizComps().filter(x => String(x.tenant_slug||'') !== s));
}


function isBizRole(role=getRole()){
  return role === 'biz_staff' || role === 'biz_admin';
}
function isSuperAdmin(role=getRole()){
  return role === 'super_admin';
}
function canAccessBiz(){
  const r = getRole();
  return isBizRole(r) || isSuperAdmin(r);
}
// Back-compat alias (some pages call isBusiness())
function isBusiness(){
  return canAccessBiz();
}
function canAccessMember(){
  const r = getRole();
  return r === 'member' || isBizRole(r) || isSuperAdmin(r);
}

function roleLabel(role){
  if(role === 'guest') return 'Guest';
  if(role === 'member') return 'Member';
  if(role === 'biz_staff') return 'Staff';
  if(role === 'biz_admin') return 'Admin';
  if(role === 'super_admin') return 'Master';
  return role || 'Guest';
}

function applyNavRole(){
  const role = getRole();
  const roleEl = qs('[data-role-pill]');
  if(roleEl) roleEl.textContent = roleLabel(role);

  const tenantEl = qs('[data-tenant-pill]');
  const slug = getTenant();
  const name = getTenantName();
  const showTenant = !!slug && (isBizRole(role) || isSuperAdmin(role));
  if(tenantEl){
    tenantEl.textContent = name || slug;
    tenantEl.style.display = showTenant ? 'inline-block' : 'none';
  }
}


// =========================
// Backbar (CP17) — clear Back/Home buttons across pages
// =========================
function injectBackBar(){
  const page = document.body && document.body.getAttribute('data-page') || '';
  if(page === 'home') return;
  if(qs('.backbar')) return;

  const header = qs('.header');
  if(!header) return;

  const bar = document.createElement('div');
  bar.className = 'backbar';

  const inner = document.createElement('div');
  inner.className = 'backbar-inner';

  const backBtn = document.createElement('button');
  backBtn.className = 'btn sm';
  backBtn.type = 'button';
  backBtn.textContent = '← Back';
  backBtn.addEventListener('click', ()=>{
    try{
      if(history.length > 1) history.back();
      else location.href = '/';
    }catch(e){
      location.href = '/';
    }
  });

  const homeLink = document.createElement('a');
  homeLink.className = 'btn sm';
  homeLink.href = '/';
  homeLink.textContent = 'Home';

  inner.appendChild(backBtn);
  inner.appendChild(homeLink);

  // Optional contextual links (only when relevant)
  const path = location.pathname || '/';
  if(path.startsWith('/app/')){
    const a = document.createElement('a');
    a.className = 'btn sm';
    a.href = '/app/';
    a.textContent = 'Member';
    inner.appendChild(a);
  }
  if(path.startsWith('/biz/')){
    const a = document.createElement('a');
    a.className = 'btn sm';
    a.href = '/biz/';
    a.textContent = 'Business';
    inner.appendChild(a);
  }
  if(path.startsWith('/admin/')){
    const a = document.createElement('a');
    a.className = 'btn sm';
    a.href = '/admin/';
    a.textContent = 'Admin';
    inner.appendChild(a);
  }

  bar.appendChild(inner);
  header.insertAdjacentElement('afterend', bar);
}

// =========================
// Equipment catalog (CP17) — clean label set + alias mapping
// =========================
let _equipCatalog = null;
let _equipById = null;
let _equipAliasToId = null;

async function loadEquipmentCatalog(){
  if(_equipCatalog !== null) return _equipCatalog;
  try{
    _equipCatalog = await loadJSON('/assets/data/equipment_catalog_v1.json');
  }catch(e){
    _equipCatalog = {version:0, equipment:[]};
  }
  const arr = Array.isArray(_equipCatalog.equipment) ? _equipCatalog.equipment : [];
  _equipById = new Map();
  _equipAliasToId = new Map();

  for(const e of arr){
    if(!e || !e.id) continue;
    _equipById.set(e.id, e);
    const aliases = new Set();
    aliases.add(String(e.id).toLowerCase().trim());
    if(e.label) aliases.add(String(e.label).toLowerCase().trim());
    (e.aliases||[]).forEach(a => aliases.add(String(a).toLowerCase().trim()));
    for(const a of aliases){
      if(a) _equipAliasToId.set(a, e.id);
    }
  }
  return _equipCatalog;
}

function equipIdFromAny(input){
  if(!_equipAliasToId) return null;
  const k = String(input||'').toLowerCase().trim();
  return _equipAliasToId.get(k) || null;
}
function equipLabelFromId(id){
  if(!_equipById) return String(id||'');
  const rec = _equipById.get(id);
  return rec ? rec.label : String(id||'');
}
function equipOptionsHTML(selectedId){
  const arr = (_equipCatalog && Array.isArray(_equipCatalog.equipment)) ? _equipCatalog.equipment : [];
  const opts = ['<option value="">Select…</option>'].concat(arr.map(e => {
    const sel = (String(selectedId||'') === String(e.id)) ? ' selected' : '';
    return `<option value="${e.id}"${sel}>${e.label}</option>`;
  }));
  return opts.join('');
}

function vimeoIdFromEmbedUrl(url){
  try{
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    for(let i=parts.length-1; i>=0; i--){
      if(/^\d+$/.test(parts[i])) return parts[i];
    }
  }catch(e){}
  // fallback: regex
  const m = String(url||'').match(/video\/(\d+)/);
  return m ? m[1] : null;
}

// Move catalog (used for timer builders + next-move previews)
let _movesCatalog = null;      // array
let _movesByVimeoId = null;    // Map(video_id -> record)

// Move tagging (lightweight heuristic, used for Builder random filters)
// NOTE: This is intentionally "good enough" until we tag the library in Supabase.
let _moveGroupCache = null; // Map(video_id -> Set(groups))

function normMoveTitle(title){
  return String(title||'')
    .toLowerCase()
    .replace(/[^a-z0-9\s+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function computeMoveGroups(title){
  const t = normMoveTitle(title);
  const groups = new Set();

  const hasAny = (list)=> list.some(k => t.includes(k));

  // Core / Abs
  if(hasAny([
    'abs','ab ','core','crunch','sit up','situp','v sit','v-sit','hollow','toe touch','russian twist','flutter',
    'leg raise','plank','dead bug','dead-bug','bird dog','bird-dog','bear','bicycle','hip thrust' // hip thrust often shows up in core combos
  ])) groups.add('abs');

  // Lower body
  if(hasAny([
    'squat','lunge','split squat','deadlift','rdl','romanian','hinge','glute','hamstring','quad','calf','step up','step-up',
    'hip thrust','hip-thrust','kickback','good morning','sumo'
  ])) groups.add('lower');

  // Upper body
  if(hasAny([
    'push up','push-up','press','shoulder','raise','row','pull','lat','chest','fly','curl','tricep','bicep','dip',
    'upright row','overhead','ohp','arm'
  ])) groups.add('upper');

  // Cardio / Conditioning
  if(hasAny([
    'burpee','sprint','jump','high knees','high-knees','skater','shuffle','fast feet','jack','jacks','pogo','plyo','run',
    'mountain climber','climber','rope','kickboxing','kick box','kick-box','boxer','knees'
  ])) groups.add('cardio');

  // Explicit total/full body hints
  if(hasAny([
    'total body','total-body','full body','full-body','complex','combo','thruster','man maker','snatch','clean','swing'
  ])) groups.add('total');

  // Derived "total" when multiple domains are present
  if((groups.has('upper') && groups.has('lower')) || (groups.has('cardio') && (groups.has('upper') || groups.has('lower')))){
    groups.add('total');
  }

  // If we still have nothing, treat as Total Body (safe fallback).
  if(groups.size === 0) groups.add('total');

  return groups;
}

function moveGroupSet(move){
  if(!_moveGroupCache) _moveGroupCache = new Map();
  const id = String(move?.video_id || '').trim();
  if(id && _moveGroupCache.has(id)) return _moveGroupCache.get(id);
  const set = computeMoveGroups(move?.title || '');
  if(id) _moveGroupCache.set(id, set);
  return set;
}

async function loadMovesCatalog(){
  if(_movesCatalog !== null) return _movesCatalog;
  try{
    const data = await loadJSON('/assets/data/videos_moves.json');
    _movesCatalog = Array.isArray(data) ? data : [];
  }catch(e){
    _movesCatalog = [];
  }
  _movesByVimeoId = new Map();
  _movesCatalog.forEach(v=>{
    const id = String(v?.video_id || '').trim();
    if(id) _movesByVimeoId.set(id, v);
  });
  return _movesCatalog;
}
function moveFromVimeoId(id){
  if(!_movesByVimeoId) return null;
  const s = String(id||'').trim();
  return _movesByVimeoId.get(s) || null;
}







async function loadJSON(path){
  const host = String(location.hostname||'');
  const noCache = new URLSearchParams(location.search).has('nocache');
  const cacheMode = (noCache || host==='localhost' || host==='127.0.0.1') ? 'no-store' : 'force-cache';
  const url = withCacheBust(path);

  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), 12000);

  let res;
  try{
    res = await fetch(url, {cache: cacheMode, signal: ctrl.signal});
  }catch(err){
    clearTimeout(t);
    throw new Error(`Failed to load ${path} (network)`);
  }finally{
    clearTimeout(t);
  }

  if(!res.ok) throw new Error(`Failed to load ${path} (${res.status})`);
  return await res.json();
}

// =========================
// Build info + cache-busting (CP26)
// =========================
const HIIT56_BUILD_ID = '2026-02-12_26';
const HIIT56_BUILD_LABEL = 'CP26';
let HIIT56_BUILD = { label: HIIT56_BUILD_LABEL, build_id: HIIT56_BUILD_ID };

function withCacheBust(url){
  try{
    const u = new URL(url, location.origin);
    if(u.origin === location.origin){
      if(!u.searchParams.has('v')) u.searchParams.set('v', HIIT56_BUILD_ID);
    }
    return u.toString();
  }catch(e){ return url; }
}

async function loadBuildInfo(){
  try{
    const res = await fetch('/assets/build.json', {cache:'no-store'});
    if(!res.ok) return HIIT56_BUILD;
    const data = await res.json();
    if(data && data.label) HIIT56_BUILD = data;
  }catch(e){ /* ignore */ }
  return HIIT56_BUILD;
}

// =========================
// Thumbnails — Vimeo best-frame overrides (CP16)
// =========================
let _thumbOverrides = null;

async function loadThumbOverrides(){
  if(_thumbOverrides !== null) return _thumbOverrides;
  try{
    _thumbOverrides = await loadJSON('/assets/data/thumbnail_overrides.json');
  }catch(e){
    _thumbOverrides = {};
  }
  if(!_thumbOverrides || typeof _thumbOverrides !== 'object') _thumbOverrides = {};
  return _thumbOverrides;
}

function thumbOverrideForId(id){
  if(!_thumbOverrides) return null;
  const key = String(id||'');
  return _thumbOverrides[key] || null;
}

function thumbForVideo(video){
  const id = video && (video.video_id ?? video.id ?? video.vimeo_id);
  const override = thumbOverrideForId(id);
  return override || (video ? video.thumbnail_url : null);
}

// =========================
// Stripe (CP13) — test wiring helpers
// =========================
let _stripePublicConfig = null;

async function loadStripePublicConfig(){
  if(_stripePublicConfig !== null) return _stripePublicConfig;
  try{
    _stripePublicConfig = await loadJSON('/assets/data/stripe_public_test.json');
  }catch(e){
    _stripePublicConfig = null;
  }
  return _stripePublicConfig;
}

function isLocalPreview(){
  const h = location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '' || location.protocol === 'file:';
}

async function startStripeCheckout({tier, plan, email, tenant_slug='', tenant_name='', biz_tier='', locations=1}){
  const cfg = await loadStripePublicConfig();
  if(!cfg) throw new Error('Stripe config missing (stripe_public_test.json).');
  const endpoint = (cfg.endpoints && cfg.endpoints.create_checkout_session)
    ? cfg.endpoints.create_checkout_session
    : '/api/stripe/create-checkout-session';

  // Require real Supabase session when available; otherwise fall back to legacy behavior.
  let subject_id = '';
  let subject_type = 'profile';
  let userEmail = '';

  try{
    if(window.supabase && window.supabase.createClient){
      const r = await fetch('/assets/data/supabase_public_test.json', {cache:'no-store'});
      if(r.ok){
        const scfg = await r.json();
        const sUrl = String(scfg.supabase_url || '').trim();
        const sKey = String(scfg.supabase_anon_key || '').trim();
        if(sUrl && sKey){
          const s = window.supabase.createClient(sUrl, sKey);
          const { data: { session } } = await s.auth.getSession();

          if(!session?.user){
            const next = encodeURIComponent(location.pathname + location.search);
            location.href = `/login.html?next=${next}`;
            return;
          }

          subject_id = session.user.id;
          userEmail = session.user.email || '';

          // Best-effort profile upsert (RLS policies already in place)
          try{
            await s.from('profiles').upsert({
              user_id: session.user.id,
              email: session.user.email ?? null,
              full_name: session.user.user_metadata?.full_name ?? null,
            }, { onConflict: 'user_id' });
          }catch(e){
            console.warn('[ensureProfile] upsert failed:', e?.message || e);
          }
        }
      }
    }
  }catch(e){
    console.warn('Supabase session check skipped:', e?.message || e);
  }

  const finalEmail = String(userEmail || email || '').trim();

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      tier,
      plan,
      biz_tier,
      locations,
      email: finalEmail,
      tenant_slug,
      tenant_name,
      subject_id: subject_id || '',
      subject_type
    })
  });

  if(!res.ok){
    const text = await res.text().catch(()=> '');
    throw new Error('Checkout session failed: ' + text);
  }
  const data = await res.json();
  if(data && data.url){
    location.href = data.url;
    return true;
  }
  throw new Error('No checkout URL returned.');
}


function injectBanner(html){
  const c = qs('.container');
  if(!c) return;
  const anchor = qs('.section-title', c);
  const b = document.createElement('div');
  b.className = 'banner';
  b.innerHTML = html;
  if(anchor && anchor.nextSibling){
    c.insertBefore(b, anchor.nextSibling);
  }else{
    c.insertBefore(b, c.firstChild);
  }
}

function groupBy(arr, keyFn){
  const m = new Map();
  for(const item of arr){
    const k = keyFn(item);
    if(!m.has(k)) m.set(k, []);
    m.get(k).push(item);
  }
  return m;
}


function bestThumb(url){
  if(!url) return url;
  // Vimeo thumbs often come in small sizes like ...-d_295x166. Request a larger size for sharper cards.
  // If the larger size 404s, we fall back to the original URL via img.onerror.
  let out = url;
  out = out.replace(/-d_\d+x\d+/i, '-d_960x540');
  out = out.replace(/-d_\d+$/i, '-d_960x540');
  return out;
}

// --- Vimeo connection hints (speed up video loads) ---
function injectVimeoPreconnect(){
  try{
    const hrefs = ['https://player.vimeo.com','https://i.vimeocdn.com'];
    for(const href of hrefs){
      if(!document.querySelector(`link[rel="preconnect"][href="${href}"]`)){
        const l = document.createElement('link');
        l.rel = 'preconnect';
        l.href = href;
        document.head.appendChild(l);
      }
      const dns = href.replace(/^https?:/, '');
      if(!document.querySelector(`link[rel="dns-prefetch"][href="${dns}"]`)){
        const d = document.createElement('link');
        d.rel = 'dns-prefetch';
        d.href = dns;
        document.head.appendChild(d);
      }
    }
  }catch(e){}
}
injectVimeoPreconnect();
  ensureStripePreconnect();

let _vimeoPlayerLibPromise = null;

function ensureVimeoPreconnect(){
  try{
    if(document.head && document.head.dataset && document.head.dataset.v56VimeoPreconnect === '1') return;
    if(document.head && document.head.dataset) document.head.dataset.v56VimeoPreconnect = '1';
    const origins = ['https://player.vimeo.com','https://i.vimeocdn.com','https://f.vimeocdn.com'];
    origins.forEach(href=>{
      const l = document.createElement('link');
      l.rel = 'preconnect';
      l.href = href;
      l.crossOrigin = 'anonymous';
      document.head.appendChild(l);
    });
  }catch(e){}
}


function ensureStripePreconnect(){
  try{
    const href = 'https://js.stripe.com';
    if(document.querySelector(`link[rel="preconnect"][href="${href}"]`)) return;
    const l = document.createElement('link');
    l.rel='preconnect'; l.href=href; l.crossOrigin='anonymous';
    document.head.appendChild(l);
  }catch(e){}
}


function normalizeVimeoEmbedUrl(url){
  if(!url) return '';
  const s = String(url);
  if(!s.includes('vimeo')) return s;
  try{
    const u = new URL(s);
    const parts = u.pathname.split('/').filter(Boolean);
    let id = null;
    let hash = null;

    for(let i=0; i<parts.length; i++){
      if(/^\d+$/.test(parts[i])){
        id = parts[i];
        if(i+1 < parts.length && !/^\d+$/.test(parts[i+1])) hash = parts[i+1];
      }
    }
    const qh = u.searchParams.get('h');
    if(qh) hash = qh;

    if(!id) return s;

    // Preserve non-empty query params (some are harmless) but force into player embed form.
    const params = new URLSearchParams(u.search);
    if(hash) params.set('h', hash);

    let out = `https://player.vimeo.com/video/${id}`;
    const qs = params.toString();
    if(qs) out += `?${qs}`;
    return out;
  }catch(e){
    return s;
  }
}


function ensureVimeoPlayerLib(){
  ensureVimeoPreconnect();
  if(window.Vimeo && window.Vimeo.Player) return Promise.resolve();
  if(_vimeoPlayerLibPromise) return _vimeoPlayerLibPromise;
  _vimeoPlayerLibPromise = new Promise((resolve, reject)=>{
    const s = document.createElement('script');
    s.src = 'https://player.vimeo.com/api/player.js';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load Vimeo player library'));
    document.head.appendChild(s);
  });
  return _vimeoPlayerLibPromise;
}

function buildVimeoSrc(base, params){
  if(!base) return '';
  base = normalizeVimeoEmbedUrl(base);
  try{
    const u = new URL(base);
    if(params){
      for(const [k,v] of Object.entries(params)){
        if(v === undefined || v === null) continue;
        u.searchParams.set(k, String(v));
      }
    }
    return u.toString();
  }catch(e){
    const join = base.includes('?') ? '&' : '?';
    const qs = Object.entries(params||{}).map(([k,v])=>`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
    return base + (qs ? (join + qs) : '');
  }
}

function getSavedVideoVolume(){
  const raw = localStorage.getItem('hiit56_video_volume');
  const v = raw == null ? 0.85 : parseFloat(raw);
  return clamp(isNaN(v) ? 0.85 : v, 0, 1);
}
function setSavedVideoVolume(v){
  localStorage.setItem('hiit56_video_volume', String(clamp(Number(v)||0, 0, 1)));
}
function getSavedVideoMuted(){
  return localStorage.getItem('hiit56_video_muted') === '1';
}
function setSavedVideoMuted(m){
  localStorage.setItem('hiit56_video_muted', m ? '1' : '0');
}

function attachVideoControls(wrap, iframe){
  if(!wrap || !iframe) return;

  // Ensure wrap is positioned for overlays
  const style = getComputedStyle(wrap);
  if(style.position === 'static') wrap.style.position = 'relative';

  const controls = document.createElement('div');
  controls.className = 'video-controls';

  const muteBtn = document.createElement('button');
  muteBtn.type = 'button';
  muteBtn.className = 'icon-btn';
  muteBtn.textContent = getSavedVideoMuted() ? 'Unmute' : 'Mute';

  const range = document.createElement('input');
  range.type = 'range';
  range.min = '0';
  range.max = '100';
  range.step = '1';
  range.value = String(Math.round(getSavedVideoVolume()*100));
  range.setAttribute('aria-label', 'Video volume');

  const hint = document.createElement('span');
  hint.className = 'hint';
  hint.textContent = 'VOL';

  controls.appendChild(muteBtn);
  controls.appendChild(range);
  controls.appendChild(hint);

  wrap.appendChild(controls);

  // Vimeo API (best effort). On some mobile browsers, programmatic volume may be restricted.
  let player = null;
  ensureVimeoPlayerLib().then(()=>{
    player = new Vimeo.Player(iframe);

    // Apply saved state
    const vol = getSavedVideoVolume();
    const muted = getSavedVideoMuted();
    player.setVolume(vol).catch(()=>{});
    player.setMuted(muted).catch(()=>{});
  }).catch(()=>{ /* fallback: user can use device volume + Vimeo controls */ });

  function apply(){
    const vol = clamp(Number(range.value)/100, 0, 1);
    setSavedVideoVolume(vol);
    const muted = getSavedVideoMuted();

    if(player){
      if(muted){
        player.setMuted(true).catch(()=>{});
      }else{
        player.setMuted(false).catch(()=>{});
        player.setVolume(vol).catch(()=>{});
      }
    }
  }

  range.addEventListener('input', ()=>{
    // sliding volume implies unmute
    setSavedVideoMuted(false);
    muteBtn.textContent = 'Mute';
    apply();
  });

  muteBtn.addEventListener('click', ()=>{
    const now = !getSavedVideoMuted();
    setSavedVideoMuted(now);
    muteBtn.textContent = now ? 'Unmute' : 'Mute';
    apply();
  });
}


function cardCategory(cat){
  const el = document.createElement('a');
  el.className = 'card';
  el.href = cat.href;
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.alt = cat.title;
  img.src = cat.hero_poster || '/assets/branding/Desktop Poster.webp';
  el.innerHTML = `
    <div class="thumb"></div>
    <div class="meta">
      <div class="title">${cat.title}</div>
      <p class="small">${fmt(cat.class_count)} classes</p>
    </div>
  `;
  qs('.thumb', el).appendChild(img);

  const pill = document.createElement('div');
  pill.className = 'pill';
  pill.textContent = (cat.hero && cat.hero.embed_url) ? 'Hero video' : 'Poster';
  el.appendChild(pill);
  return el;
}

function cardVideo(video){
  const el = document.createElement('div');
  el.className = 'card';
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', `Play ${video.title}`);

  const img = document.createElement('img');
  img.loading = 'lazy';
  img.alt = video.title;
  const origThumb = thumbForVideo(video) || '/assets/branding/Desktop Poster.webp';
  img.src = bestThumb(origThumb);
  img.onerror = ()=>{ if(img.src !== origThumb) img.src = origThumb; };

  el.innerHTML = `
    <div class="thumb"></div>
    <div class="meta">
      <div class="title">${video.title}</div>
      <p class="small">Vimeo ID: ${video.video_id ?? ''}</p>
    </div>
  `;
  qs('.thumb', el).appendChild(img);

  el.addEventListener('click', ()=> openVideoModal(video));
  el.addEventListener('keydown', (e)=>{
    if(e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openVideoModal(video); }
  });
  return el;
}

function cardLinkVideo(video, href, pillText){
  const el = document.createElement('a');
  el.className = 'card';
  el.href = href;

  const img = document.createElement('img');
  img.loading = 'lazy';
  img.alt = video.title;
  const origThumb = thumbForVideo(video) || '/assets/branding/Desktop Poster.webp';
  img.src = bestThumb(origThumb);
  img.onerror = ()=>{ if(img.src !== origThumb) img.src = origThumb; };

  el.innerHTML = `
    <div class="thumb"></div>
    <div class="meta">
      <div class="title">${video.title}</div>
      <p class="small">Vimeo ID: ${video.video_id ?? ''}</p>
    </div>
  `;
  qs('.thumb', el).appendChild(img);

  const pill = document.createElement('div');
  pill.className = 'pill';
  pill.textContent = pillText || 'Open';
  el.appendChild(pill);
  return el;
}

function detailHrefForVideo(video){
  const id = encodeURIComponent(String(video.video_id ?? ''));
  const path = location.pathname || '/';
  if(path.startsWith('/biz/')) return `/biz/moves/move.html?vid=${id}`;
  if(path.startsWith('/app/')) return `/app/workouts/workout.html?vid=${id}`;
  return `/workouts/workout.html?vid=${id}`;
}

function openVideoModal(video){
  const modal = qs('#videoModal');
  if(!modal) return;

  const headTitle = qs('[data-modal-title]', modal);
  const body = qs('[data-modal-body]', modal);
  if(headTitle) headTitle.textContent = video.title || 'Video';

  body.innerHTML = '';

  // Overlay actions (open detail page)
  const overlay = document.createElement('div');
  overlay.className = 'video-overlay-actions';

  const openLink = document.createElement('a');
  openLink.className = 'btn';
  openLink.href = detailHrefForVideo(video);
  openLink.textContent = 'Open page';

  overlay.appendChild(openLink);
  body.appendChild(overlay);

  const slot = document.createElement('div');
  slot.style.position = 'absolute';
  slot.style.inset = '0';
  slot.style.width = '100%';
  slot.style.height = '100%';
  body.appendChild(slot);

  renderVideoInto(slot, video.embed_url || video.embed || '', {
    autoplay:false,
    posterUrl: thumbForVideo(video) || null,
    vimeoLink: video.vimeo_link || null
  });

  modal.classList.add('open');
}

function closeVideoModal(){
  const modal = qs('#videoModal');
  if(!modal) return;
  const body = qs('[data-modal-body]', modal);
  if(body) body.innerHTML = '';
  modal.classList.remove('open');
}

function wireModal(){
  const modal = qs('#videoModal');
  if(!modal) return;

  const closeBtn = qs('[data-modal-close]', modal);
  if(closeBtn) closeBtn.addEventListener('click', closeVideoModal);

  modal.addEventListener('click', (e)=>{
    if(e.target === modal) closeVideoModal();
  });

  window.addEventListener('keydown', (e)=>{
    if(e.key === 'Escape' && modal.classList.contains('open')) closeVideoModal();
  });
}

function renderHero(cat){
  const heroWrap = qs('[data-hero]');
  if(!heroWrap) return;

  heroWrap.innerHTML = '';
  if(cat.hero && cat.hero.embed_url){
    renderVideoInto(heroWrap, cat.hero.embed_url, {
      autoplay: true,
      loop: true,
      muted: true,
      controls: false,
      volumeControls: false,
      posterUrl: cat.hero_poster || '/assets/branding/Desktop Poster.webp',
      vimeoLink: cat.hero.vimeo_link || null
    });
  } else {
    const img = document.createElement('img');
    img.alt = cat.title;
    img.src = cat.hero_poster || '/assets/branding/Desktop Poster.webp';
    heroWrap.appendChild(img);
  }
}

function renderVideoInto(wrap, embedUrl, {autoplay=false, posterUrl=null, vimeoLink=null, loop=false, muted=false, controls=true, volumeControls=true}={}){
  if(!wrap) return;
  wrap.innerHTML = '';
  try{ wrap.classList.add('video-shell'); }catch(e){}
  ensureVimeoPreconnect();
  wrap.style.position = wrap.style.position || 'relative';

  // Poster (so it feels instant even if Vimeo takes a moment)
  const poster = document.createElement('img');
  poster.alt = 'Video poster';
  poster.src = bestThumb(posterUrl || '/assets/branding/Desktop Poster.webp');
  poster.onerror = ()=>{ /* ignore */ };
  poster.style.position = 'absolute';
  poster.style.inset = '0';
  poster.style.width = '100%';
  poster.style.height = '100%';
  poster.style.objectFit = 'cover';
  poster.style.zIndex = '1';
  wrap.appendChild(poster);

  const loading = document.createElement('div');
  loading.className = 'video-loading';
  loading.textContent = 'Loading video…';
  wrap.appendChild(loading);

  const iframe = document.createElement('iframe');
  iframe.allow = 'autoplay; fullscreen; picture-in-picture';
  iframe.allowFullscreen = true;
  iframe.loading = (autoplay ? 'eager' : 'lazy');
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  iframe.style.border = '0';
  iframe.style.position = 'absolute';
  iframe.style.inset = '0';
  iframe.style.zIndex = '3';
  iframe.src = 'about:blank';
  wrap.appendChild(iframe);

  const finalSrc = buildVimeoSrc(embedUrl || '', {
    autoplay: autoplay ? 1 : 0,
    loop: loop ? 1 : 0,
    muted: muted ? 1 : 0,
    controls: controls ? 1 : 0,
    title: 0,
    byline: 0,
    portrait: 0,
    autopause: 0
  });

  // Defer setting src by a tick so the UI paints first.
  requestAnimationFrame(()=>{ iframe.src = finalSrc; });

  iframe.addEventListener('load', ()=>{
    if(loading && loading.parentNode) loading.parentNode.removeChild(loading);
    if(poster){
      poster.style.transition = 'opacity .25s ease';
      poster.style.opacity = '0';
      setTimeout(()=>{ if(poster.parentNode) poster.parentNode.removeChild(poster); }, 300);
    }
  }, {once:true});

  // Slow-load / fail-safe fallback
  const fallback = document.createElement('div');
  fallback.className = 'video-fallback';
  fallback.innerHTML = `
    <div class="banner">
      <strong>Having trouble loading?</strong>
      <div class="small">If the player doesn’t load, open the video directly.</div>
      <div class="btn-row" style="margin-top:10px">
        <a class="btn" target="_blank" rel="noopener" href="${vimeoLink || '#'}">Open in Vimeo</a>
      </div>
    </div>
  `;
  wrap.appendChild(fallback);

  const t = setTimeout(()=>{
    if(vimeoLink){
      fallback.style.display = 'block';
    }
  }, 8000);

  iframe.addEventListener('load', ()=> clearTimeout(t), {once:true});

  if(volumeControls){
    attachVideoControls(wrap, iframe);
  }
}

async function pagePublicWorkouts(){
  const data = await loadJSON('/assets/data/categories_v1.json');
  const root = qs('[data-category-root]');
  if(!root) return;

  const grouped = groupBy(data.categories, c => c.group);
  root.innerHTML = '';
  for(const [group, cats] of grouped.entries()){
    const wrap = document.createElement('div');
    wrap.className = 'group';
    wrap.innerHTML = `<h3>${group} <span class="badge">Preview</span></h3>`;

    const grid = document.createElement('div');
    grid.className = 'grid';

    cats.forEach(c=>{
      grid.appendChild(cardCategory({
        ...c,
        href: `/workouts/category.html?c=${encodeURIComponent(c.slug)}`
      }));
    });

    wrap.appendChild(grid);
    root.appendChild(wrap);
  }
}

async function pageMemberWorkouts(){
  const data = await loadJSON('/assets/data/categories_v1.json');
  const root = qs('[data-category-root]');
  if(!root) return;

  // Render categories
  const grouped = groupBy(data.categories, c => c.group);
  root.innerHTML = '';
  for(const [group, cats] of grouped.entries()){
    const wrap = document.createElement('div');
    wrap.className = 'group';
    wrap.innerHTML = `<h3>${group} <span class="badge">Member</span></h3>`;

    const grid = document.createElement('div');
    grid.className = 'grid';

    cats.forEach(c=>{
      grid.appendChild(cardCategory({
        ...c,
        href: `/app/workouts/category.html?c=${encodeURIComponent(c.slug)}`
      }));
    });

    wrap.appendChild(grid);
    root.appendChild(wrap);
  }

  // Global search across all prerecorded classes
  const searchRoot = qs('[data-global-search-root]');
  const searchInput = qs('[data-global-search]');
  const searchCount = qs('[data-global-search-count]');
  const searchLoadMore = qs('[data-global-search-load-more]');

  if(searchInput && searchRoot){
    const all = await loadJSON('/assets/data/videos_classes.json');
    let filtered = [];
    let shown = 0;
    const pageSize = 24;

    function paint(reset=true){
      if(reset){
        searchRoot.innerHTML = '';
        shown = 0;
      }
      const slice = filtered.slice(shown, shown + pageSize);
      slice.forEach(v => searchRoot.appendChild(cardLinkVideo(v, `/app/workouts/workout.html?vid=${encodeURIComponent(String(v.video_id))}`, 'Details')));
      shown += slice.length;
      show(searchLoadMore, shown < filtered.length);
      if(searchCount) searchCount.textContent = filtered.length ? `${fmt(filtered.length)} matches` : '';
    }

    function applyQuery(){
      const q = searchInput.value.trim().toLowerCase();
      if(!q){
        show(searchRoot, false);
        show(searchLoadMore, false);
        show(root, true);
        if(searchCount) searchCount.textContent = '';
        return;
      }
      filtered = all.filter(v => (v.title||'').toLowerCase().includes(q))
                    .sort((a,b)=>(b.video_id||0)-(a.video_id||0));
      show(root, false);
      show(searchRoot, true);
      paint(true);
    }

    if(searchLoadMore) searchLoadMore.addEventListener('click', ()=> paint(false));
    searchInput.addEventListener('input', applyQuery);
    applyQuery();
  }
}

async function pageCategory({mode}){
  // mode: 'public' or 'member'
  const url = new URL(location.href);
  const slug = url.searchParams.get('c') || '';

  const catsData = await loadJSON('/assets/data/categories_v1.json');
  const cat = catsData.categories.find(c => c.slug === slug) || catsData.categories[0];

  const titleEl = qs('[data-cat-title]');
  const countEl = qs('[data-cat-count]');
  if(titleEl) titleEl.textContent = cat.title;
  if(countEl) countEl.textContent = `${fmt(cat.class_count)} classes`;

  // Draft banner
  const banner = qs('[data-taxonomy-banner]');
  if(banner) show(banner, Boolean(cat.status && cat.status.includes('DRAFT')));

  // Public preview note tweaks
  const previewNote = qs('[data-preview-note]');
  if(previewNote && mode === 'public'){
    if(cat.slug === 'hiit'){
      previewNote.innerHTML = `Public preview shows <span class="badge">1</span> teaser per section: HIIT, Max Cardio, Specials. Members see the full library.`;
    } else {
      previewNote.innerHTML = `Public preview shows up to <span class="badge">3</span> teaser videos. Members see the full library.`;
    }
  }

  renderHero(cat);

  const all = await loadJSON('/assets/data/videos_classes.json');
  const vidsAll = all.filter(v => v.category_slug === cat.slug)
                     .sort((a,b)=>(b.video_id||0)-(a.video_id||0));

  // HIIT has two extra sections:
  // 1) Max Cardio (separate category, shown under HIIT)
  // 2) Specials/Mash-Ups (subset of HIIT, shown last)
  const isHIIT = (cat.slug === 'hiit');

  // Specials subset (listed last)
  const specialsIds = (cat.specials_video_ids || []).map(Number);
  const specialsSet = new Set(specialsIds);

  const mainVids = (specialsIds.length && isHIIT) ? vidsAll.filter(v => !specialsSet.has(Number(v.video_id))) : vidsAll;
  const specialsVids = (specialsIds.length && isHIIT) ? vidsAll.filter(v => specialsSet.has(Number(v.video_id))) : [];

  // Max Cardio list
  let maxCardioVids = [];
  if(isHIIT){
    maxCardioVids = all.filter(v => v.category_slug === 'max-cardio-hiit')
                       .sort((a,b)=>(b.video_id||0)-(a.video_id||0));
  }

  // Public: teaser-limited (HIIT uses 1 per section; other categories use 3)
  const teaserN = (mode === 'public') ? (isHIIT ? 1 : 3) : 999999;

  const mainAllowed = (mode === 'public') ? mainVids.slice(0, teaserN) : mainVids;
  const maxAllowed  = (mode === 'public') ? maxCardioVids.slice(0, teaserN) : maxCardioVids;
  const specialsAllowed = (mode === 'public') ? specialsVids.slice(0, teaserN) : specialsVids;

  const listRoot = qs('[data-video-root]');
  const maxRoot = qs('[data-max-cardio-root]');
  const specialsRoot = qs('[data-special-video-root]');

  const maxSection = qs('[data-max-cardio-section]');
  const specialsSection = qs('[data-specials-section]');

  const search = qs('[data-search]');
  const loadMoreBtn = qs('[data-load-more]');

  let filteredMain = mainAllowed;
  let filteredMax = maxAllowed;
  let filteredSpecials = specialsAllowed;

  let shown = 0;
  const pageSize = 24;

  function paintList(root, items){
    if(!root) return;
    root.innerHTML = '';
    items.forEach(v => root.appendChild(cardVideo(v)));
  }

  function paintSpecials(){
    if(!specialsRoot) return;
    paintList(specialsRoot, filteredSpecials);
    if(specialsSection) show(specialsSection, isHIIT && filteredSpecials.length > 0);
  }

  function paintMax(){
    if(!maxRoot) return;
    paintList(maxRoot, filteredMax);
    if(maxSection) show(maxSection, isHIIT && filteredMax.length > 0);
  }

  function paintMain(reset=true){
    if(!listRoot) return;
    if(reset){
      listRoot.innerHTML = '';
      shown = 0;
    }
    const slice = (mode === 'public') ? filteredMain : filteredMain.slice(shown, shown + pageSize);
    slice.forEach(v => listRoot.appendChild(cardVideo(v)));
    shown += slice.length;
    if(loadMoreBtn) show(loadMoreBtn, (mode !== 'public') && shown < filteredMain.length);
  }

  function applySearch(){
    const q = (search ? search.value.trim().toLowerCase() : '');
    if(!q){
      filteredMain = mainAllowed;
      filteredMax = maxAllowed;
      filteredSpecials = specialsAllowed;
    }else{
      const match = (v)=> (v.title||'').toLowerCase().includes(q);
      filteredMain = mainAllowed.filter(match);
      filteredMax = maxAllowed.filter(match);
      filteredSpecials = specialsAllowed.filter(match);
    }
    paintMain(true);
    paintMax();
    paintSpecials();
  }

  if(search){
    search.addEventListener('input', ()=>{
      // reset pagination when searching
      shown = 0;
      applySearch();
    });
  }
  if(loadMoreBtn) loadMoreBtn.addEventListener('click', ()=> paintMain(false));

  // initial paint
  applySearch();

  // CTA on public category page
  const cta = qs('[data-public-cta]');
  if(cta) show(cta, mode === 'public');

  // Hide HIIT-only section titles in non-HIIT categories
  if(!isHIIT){
    if(maxSection) show(maxSection, false);
    if(specialsSection) show(specialsSection, false);
  }
}

async function pageWorkoutDetail({mode}){
  // mode: 'public' or 'member'
  const url = new URL(location.href);
  const vid = Number(url.searchParams.get('vid') || 0);

  const catsData = await loadJSON('/assets/data/categories_v1.json');
  const all = await loadJSON('/assets/data/videos_classes.json');

  const video = all.find(v => Number(v.video_id) === vid) || all[0];
  const cat = catsData.categories.find(c => c.slug === video.category_slug) || null;

  const titleEl = qs('[data-workout-title]');
  const catEl = qs('[data-workout-category]');
  const metaEl = qs('[data-workout-meta]');

  if(titleEl) titleEl.textContent = video.title || (mode === 'public' ? 'Workout Preview' : 'Workout');
  if(catEl) catEl.textContent = cat ? cat.title : (video.category_slug || '');
  if(metaEl) metaEl.textContent = `Vimeo ID: ${video.video_id}`;

  // Draft banner
  const banner = qs('[data-taxonomy-banner]');
  if(banner) show(banner, Boolean(cat && cat.status && cat.status.includes('DRAFT')));

  // Back link
  const back = qs('[data-back-to-category]');
  if(back){
    back.href = cat
      ? ((mode === 'public') ? `/workouts/category.html?c=${encodeURIComponent(cat.slug)}` : `/app/workouts/category.html?c=${encodeURIComponent(cat.slug)}`)
      : ((mode === 'public') ? '/workouts/' : '/app/workouts/');
  }

  const playerWrap = qs('[data-workout-player]');

  // Public gating: only allow category teaser IDs
  if(mode === 'public'){
    const allowed = new Set(catsData.categories.flatMap(c => c.teaser_video_ids || []).map(Number));
    const locked = qs('[data-locked]');

    if(!allowed.has(Number(video.video_id))){
      show(locked, true);
      if(playerWrap){
        playerWrap.innerHTML = `<img alt="Preview locked" src="${cat?.hero_poster || '/assets/branding/Desktop Poster.webp'}">`;
      }
    } else {
      show(locked, false);
      renderVideoInto(playerWrap, video.embed_url, {autoplay:false, posterUrl: thumbForVideo(video), vimeoLink: video.vimeo_link});
    }
  } else {
    renderVideoInto(playerWrap, video.embed_url, {autoplay:false, posterUrl: thumbForVideo(video), vimeoLink: video.vimeo_link});
  }

  // Related
  const relatedRoot = qs('[data-related-root]');
  if(relatedRoot){
    relatedRoot.innerHTML = '';

    if(mode === 'public' && cat){
      // Only tease IDs
      const ids = (cat.teaser_video_ids || []).map(Number);
      const rel = ids.map(id => all.find(v=>Number(v.video_id)===id)).filter(Boolean);
      rel.filter(v => Number(v.video_id) !== Number(video.video_id))
         .slice(0, 8)
         .forEach(v => relatedRoot.appendChild(cardLinkVideo(v, `/workouts/workout.html?vid=${encodeURIComponent(String(v.video_id))}`, 'Open')));
      return;
    }

    const rel = all.filter(v => v.category_slug === video.category_slug && Number(v.video_id) !== Number(video.video_id))
                   .sort((a,b)=>(b.video_id||0)-(a.video_id||0))
                   .slice(0, 8);

    rel.forEach(v => relatedRoot.appendChild(cardLinkVideo(v, `/app/workouts/workout.html?vid=${encodeURIComponent(String(v.video_id))}`, 'Open')));
  }
}

async function pageBizMoves(){
  const gate = qs('[data-biz-gate]');
  if(!isBusiness()){
    show(gate, true);
    show(qs('[data-move-root]'), false);
    show(qs('[data-load-more]'), false);
    return;
  }
  show(gate, false);

  const listRoot = qs('[data-move-root]');
  const search = qs('[data-move-search]');
  const count = qs('[data-move-search-count]');
  const loadMoreBtn = qs('[data-load-more]');

  const all = await loadJSON('/assets/data/videos_moves.json');
  const sorted = all.slice().sort((a,b)=>(b.video_id||0)-(a.video_id||0));

  let filtered = sorted;
  let shown = 0;
  const pageSize = 24;

  function paint(reset=true){
    if(reset){
      listRoot.innerHTML = '';
      shown = 0;
    }
    const slice = filtered.slice(shown, shown + pageSize);
    slice.forEach(v => listRoot.appendChild(cardLinkVideo(v, `/biz/moves/move.html?vid=${encodeURIComponent(String(v.video_id))}`, 'Details')));
    shown += slice.length;
    show(loadMoreBtn, shown < filtered.length);
    if(count) count.textContent = `${fmt(filtered.length)} moves`;
  }

  if(search){
    search.addEventListener('input', ()=>{
      const q = search.value.trim().toLowerCase();
      filtered = sorted.filter(v => (v.title||'').toLowerCase().includes(q));
      paint(true);
    });
  }
  if(loadMoreBtn) loadMoreBtn.addEventListener('click', ()=> paint(false));

  paint(true);
}

async function pageBizMoveDetail(){
  const gate = qs('[data-biz-gate]');
  if(!isBusiness()){
    show(gate, true);
    show(qs('[data-move-player]'), false);
    show(qs('[data-related-root]'), false);
    return;
  }
  show(gate, false);

  const url = new URL(location.href);
  const vid = Number(url.searchParams.get('vid') || 0);

  const all = await loadJSON('/assets/data/videos_moves.json');
  const move = all.find(v => Number(v.video_id) === vid) || all[0];

  const titleEl = qs('[data-move-title]');
  const metaEl = qs('[data-move-meta]');

  if(titleEl) titleEl.textContent = move.title || 'Move';
  if(metaEl) metaEl.textContent = `Vimeo ID: ${move.video_id}`;

  renderVideoInto(qs('[data-move-player]'), move.embed_url, {autoplay:false, posterUrl: thumbForVideo(move), vimeoLink: move.vimeo_link});

  const relatedRoot = qs('[data-related-root]');
  if(relatedRoot){
    relatedRoot.innerHTML = '';
    all.filter(v => Number(v.video_id) !== Number(move.video_id))
       .sort((a,b)=>(b.video_id||0)-(a.video_id||0))
       .slice(0, 8)
       .forEach(v => relatedRoot.appendChild(cardLinkVideo(v, `/biz/moves/move.html?vid=${encodeURIComponent(String(v.video_id))}`, 'Open')));
  }
}


async function pageMemberTimer(){
  await loadEquipmentCatalog();
  await loadMovesCatalog();

  const data = await loadJSON('/assets/data/timer_demos.json');
  const demos = (data.demos || []).filter(d => d.mode === 'online');

  const demoSel = qs('[data-demo-select]');
  const capMin = qs('[data-cap-min]');
  const capPool = qs('[data-cap-pool]');
  const capUnder = qs('[data-cap-under]');
  const capFillAllChk = qs('[data-capfill-all]');
  const capFillGroupChks = qsa('[data-capfill-group]');
  const capFillBalanceChk = qs('[data-capfill-balance]');
  const capFillStrictChk = qs('[data-capfill-strict]');
  const capFillNoRepeatChk = qs('[data-capfill-norepeat]');
  const capFillSecIn = qs('[data-capfill-sec]');
  const speedSel = qs('[data-speed]');
  const totalTime = qs('[data-total-time]');
  const capStatus = qs('[data-cap-status]');
  const volRange = qs('[data-beep-volume]');
  const countdownChk = qs('[data-countdown-beeps]');
  const keepAwakeChk = qs('[data-keep-awake]');
  const autoPauseChk = qs('[data-auto-pause-hidden]');
  const startBtn = qs('[data-start]');
  const pauseBtn = qs('[data-pause]');
  const skipBtn = qs('[data-skip]');
  const resetBtn = qs('[data-reset]');
  const applyCapBtn = qs('[data-apply-cap]');
  const undoCapBtn = qs('[data-undo-cap]');
  const testBeepBtn = qs('[data-test-beep]');
  const clockEl = qs('[data-clock]');
  const segKindEl = qs('[data-seg-kind]');
  const stageEl = qs('[data-stage]');
  const moveEl = qs('[data-move]');
  const nextEl = qs('[data-next]');
  const timelineEl = qs('[data-timeline]');
  const videoWrap = qs('[data-video]');
  const videoCard = qs('[data-video-wrap]');
  const overlayEl = qs('[data-timer-overlay]');
  const nextPreview = qs('[data-next-preview]');
  const nextThumb = qs('[data-next-thumb]');
  const nextLabel = qs('[data-next-label]');
  const builderBtn = qs('[data-open-builder]');
  const myBtn = qs('[data-open-myworkouts]');

  // Local-only equipment mapping (per move video)
  const EQUIP_KEY_PREFIX = 'hiit56_member_move_equip_v1_';
  let lastMoveKey = null;

  function keyForMove(meta){
    const vid = vimeoIdFromEmbedUrl(meta?.video_embed_url || '');
    if(vid) return `vid:${vid}`;
    const name = String(meta?.move_name || '').trim().toLowerCase();
    return name ? `name:${name}` : null;
  }

  function getEquipForKey(key){
    if(!key) return {equip_ids:[], note:''};
    return readJSON(EQUIP_KEY_PREFIX + key, {equip_ids:[], note:''}) || {equip_ids:[], note:''};
  }
  function setEquipForKey(key, payload){
    if(!key) return;
    writeJSON(EQUIP_KEY_PREFIX + key, payload || {equip_ids:[], note:''});
  }

  // Equipment UI
  const equipPanel = qs('[data-equip-panel]');
  const equipList = qs('[data-equip-list]');
  const equipNote = qs('[data-equip-note]');
  const equipEditBtn = qs('[data-equip-edit]');

  const equipModal = qs('#equipModal');
  const equipModalTitle = qs('[data-equip-modal-title]');
  const equipModalClose = qs('[data-equip-modal-close]');
  const equipModalSelect = qs('[data-equip-select]');
  const equipModalAdd = qs('[data-equip-add]');
  const equipModalSelected = qs('[data-equip-selected]');
  const equipModalNote = qs('[data-equip-modal-note]');
  const equipModalSave = qs('[data-equip-save]');

  let equipDraft = {equip_ids:[], note:''};

  function openEquipModalForKey(key, label){
    if(!equipModal) return;
    lastMoveKey = key;
    equipDraft = getEquipForKey(key);
    if(equipModalTitle) equipModalTitle.textContent = label || 'Equipment';
    if(equipModalSelect) equipModalSelect.innerHTML = equipOptionsHTML('');
    if(equipModalNote) equipModalNote.value = String(equipDraft.note || '');
    renderEquipSelected();
    equipModal.setAttribute('aria-hidden', 'false');
    equipModal.style.display = 'flex';
  }
  function closeEquipModal(){
    if(!equipModal) return;
    equipModal.setAttribute('aria-hidden', 'true');
    equipModal.style.display = 'none';
  }
  function renderEquipSelected(){
    if(!equipModalSelected) return;
    equipModalSelected.innerHTML = '';
    (equipDraft.equip_ids || []).forEach(id=>{
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = equipLabelFromId(id);
      const x = document.createElement('button');
      x.className = 'chip-x';
      x.textContent = '×';
      x.addEventListener('click', ()=>{
        equipDraft.equip_ids = (equipDraft.equip_ids||[]).filter(e=>String(e)!==String(id));
        renderEquipSelected();
      });
      chip.appendChild(x);
      equipModalSelected.appendChild(chip);
    });
    if(!(equipDraft.equip_ids||[]).length){
      equipModalSelected.innerHTML = '<span class="small">No equipment selected</span>';
    }
  }

  if(equipEditBtn){
    equipEditBtn.addEventListener('click', ()=>{
      if(!lastMoveKey) return;
      openEquipModalForKey(lastMoveKey, 'Equipment');
    });
  }
  if(equipModalClose) equipModalClose.addEventListener('click', closeEquipModal);
  if(equipModal) equipModal.addEventListener('click', (e)=>{ if(e.target === equipModal) closeEquipModal(); });

  if(equipModalAdd){
    equipModalAdd.addEventListener('click', ()=>{
      const id = equipIdFromAny(equipModalSelect?.value);
      if(!id) return;
      const cur = new Set(equipDraft.equip_ids || []);
      cur.add(id);
      equipDraft.equip_ids = Array.from(cur);
      renderEquipSelected();
      if(equipModalSelect) equipModalSelect.value = '';
    });
  }
  if(equipModalSave){
    equipModalSave.addEventListener('click', ()=>{
      if(equipModalNote) equipDraft.note = String(equipModalNote.value||'').trim();
      setEquipForKey(lastMoveKey, equipDraft);
      closeEquipModal();
      // refresh panel immediately if running
      if(lastWorkSeg) refreshEquipUIForSegment(lastWorkSeg);
    });
  }

  function refreshEquipUIForSegment(seg){
    if(!equipPanel) return;
    const meta = seg?.meta || {};
    const key = keyForMove(meta);
    lastMoveKey = key;
    const payload = getEquipForKey(key);
    const ids = Array.isArray(payload.equip_ids) ? payload.equip_ids : [];
    if(equipList){
      equipList.innerHTML = ids.length ? ids.map(id=>`<span class="chip">${equipLabelFromId(id)}</span>`).join('') : '<span class="small">No equipment set</span>';
    }
    if(equipNote){
      equipNote.textContent = payload.note ? payload.note : '';
      show(equipNote, !!payload.note);
    }
  }

  // Preferences
  const COUNTDOWN_KEY = 'hiit56_timer_countdown_beeps';
  const AWAKE_KEY = 'hiit56_timer_keep_awake';
  const AUTOPAUSE_KEY = 'hiit56_timer_autopause_hidden';

  function readBool(key, fallback){
    const raw = localStorage.getItem(key);
    if(raw === null) return !!fallback;
    return raw === '1' || raw === 'true';
  }
  function writeBool(key, val){
    localStorage.setItem(key, val ? '1' : '0');
  }

  if(countdownChk){ countdownChk.checked = readBool(COUNTDOWN_KEY, true); countdownChk.addEventListener('change', ()=> writeBool(COUNTDOWN_KEY, countdownChk.checked)); }
  if(keepAwakeChk){ keepAwakeChk.checked = readBool(AWAKE_KEY, true); keepAwakeChk.addEventListener('change', ()=> writeBool(AWAKE_KEY, keepAwakeChk.checked)); }
  if(autoPauseChk){ autoPauseChk.checked = readBool(AUTOPAUSE_KEY, true); autoPauseChk.addEventListener('change', ()=> writeBool(AUTOPAUSE_KEY, autoPauseChk.checked)); }

  // Timer state
  const KIND_CLASS = {WORK:'kind-work',REST:'kind-rest',MOVE_TRANSITION_A:'kind-move-a',MOVE_TRANSITION_B:'kind-move-b',STATION_STAGE_TRANSITION:'kind-station'};
  let baseSegments = [];
  let segments = [];
  let capUndoSnapshot = null;
  let engine = null;
  let lastWorkSeg = null;
  let activeSourceId = null;
  let lastCountdown = {idx:null, sec:null};
  let currentEmbed = null;

  function setVolFromUI(){
    if(!volRange) return;
    const v = clamp(Number(volRange.value||0)/100, 0, 1);
    setBeepVolume(v);
  }
  function syncVolUI(){
    if(!volRange) return;
    volRange.value = String(Math.round(getBeepVolume()*100));
  }

  function updateTotals(note=''){
    if(totalTime) totalTime.textContent = fmtTime(computeTotalSec(segments));
    if(capStatus){
      capStatus.textContent = note || '';
    }
  }

  function renderTimeline(activeIdx){
    if(!timelineEl) return;
    timelineEl.innerHTML = '';
    segments.slice(0, 18).forEach((s,i)=>{
      const item = document.createElement('div');
      item.className = 'timeline-item ' + (KIND_CLASS[s.kind]||'');
      if(i===activeIdx) item.classList.add('active');
      const left = document.createElement('div');
      left.className = 'left';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = kindLabel(s.kind) + (s.kind==='WORK' && s.meta?.move_name ? ` — ${s.meta.move_name}` : '');
      const right = document.createElement('div');
      right.className = 'right';
      right.textContent = fmtTime(s.duration_sec);
      left.appendChild(name);
      item.appendChild(left);
      item.appendChild(right);
      timelineEl.appendChild(item);
    });
  }

  function setVideoForSegment(seg, idx){
    if(!videoCard || !videoWrap) return;

    // Member timer behavior:
    // - WORK segments show that move's looping video
    // - REST / TRANSITIONS show the *upcoming* WORK move video (preloads and feels instant)
    // - If no upcoming WORK exists, fall back to last WORK video
    if(seg && seg.kind === 'WORK'){
      lastWorkSeg = seg;
    }

    // Ensure 2-layer video buffers (active + preload)
    let alt = qs('[data-video-alt]');
    if(!alt){
      alt = document.createElement('div');
      alt.className = 'timer-video-inner is-hidden';
      alt.setAttribute('data-video-alt','');
      // Insert alt layer before overlay
      videoCard.insertBefore(alt, overlayEl || null);
    }
    // Mark primary as active if neither is marked
    if(!videoWrap.classList.contains('is-active') && !alt.classList.contains('is-active')){
      videoWrap.classList.add('is-active');
      videoWrap.classList.remove('is-hidden');
      alt.classList.add('is-hidden');
    }

    function layerEmbed(el){ return (el && el.dataset) ? (el.dataset.embed || '') : ''; }
    function setLayerEmbed(el, embed){
      if(!el) return;
      const e = String(embed||'');
      if(layerEmbed(el) === e) return;
      if(!e){
        el.innerHTML = '<img alt="HIIT56" src="/assets/branding/Desktop Poster.webp">';
        el.dataset.embed = '';
        return;
      }
      const src = buildVimeoSrc(e, {
        autoplay: 1, loop: 1, muted: 1, background: 1, controls: 0,
        title: 0, byline: 0, portrait: 0, playsinline: 1, autopause: 0
      });
      el.innerHTML = `<iframe loading="eager" src="${src}" allow="autoplay; fullscreen; picture-in-picture" title="Move video"></iframe>`;
      el.dataset.embed = e;
    }
    function swapTo(embed){
      const want = String(embed||'');
      const a = videoWrap;
      const b = alt;
      const active = a.classList.contains('is-active') ? a : b;
      const inactive = (active === a) ? b : a;

      if(layerEmbed(active) === want) return;

      if(layerEmbed(inactive) !== want){
        setLayerEmbed(inactive, want);
      }
      active.classList.remove('is-active');
      active.classList.add('is-hidden');
      inactive.classList.add('is-active');
      inactive.classList.remove('is-hidden');
    }

    // Choose which move video should be displayed for THIS segment.
    let vSeg = null;
    if(seg && seg.kind === 'WORK'){
      vSeg = seg;
    }else{
      // prefer upcoming work (rest/transition = preview next move)
      const next = (typeof idx === 'number') ? findNextWork(idx) : null;
      vSeg = next?.seg || lastWorkSeg;
    }

    const desiredEmbed = vSeg?.meta?.video_embed_url || '';
    if(!desiredEmbed){
      swapTo('');
    }else{
      swapTo(desiredEmbed);
    }

    // Preload the next-needed WORK embed into the hidden layer (gives WORK/REST time to buffer).
    const upcoming = (typeof idx === 'number') ? findNextWork(idx) : null;
    let preloadSeg = null;
    if(seg && seg.kind === 'WORK'){
      preloadSeg = upcoming?.seg || null;
    }else{
      preloadSeg = upcoming ? (findNextWork(upcoming.idx)?.seg || null) : null;
    }
    const preloadEmbed = preloadSeg?.meta?.video_embed_url || '';
    const a = videoWrap;
    const b = alt;
    const active = a.classList.contains('is-active') ? a : b;
    const inactive = (active === a) ? b : a;
    if(preloadEmbed && preloadEmbed !== layerEmbed(active)){
      setLayerEmbed(inactive, preloadEmbed);
      // Do not swap yet — just buffer silently.
      inactive.classList.add('is-hidden');
      inactive.classList.remove('is-active');
    }
  }

  function setRunModeForSegment(seg){
    if(!videoCard || !seg) return;
    const k = seg.kind;
    videoCard.classList.toggle('mode-work', k==='WORK');
    videoCard.classList.toggle('mode-rest', k==='REST');
    videoCard.classList.toggle('mode-transition', (k==='MOVE_TRANSITION_A'||k==='MOVE_TRANSITION_B'||k==='STATION_STAGE_TRANSITION'));
    if(overlayEl){
      overlayEl.classList.toggle('overlay-compact', k==='WORK');
    }
    if(clockEl){
      clockEl.classList.toggle('big', k!=='WORK');
    }
  }

  function findNextWork(fromIdx){
    for(let i=fromIdx+1; i<segments.length; i++){
      if(segments[i].kind === 'WORK') return {idx:i, seg:segments[i]};
    }
    return null;
  }

  function updateNextPreview(fromIdx){
    const next = findNextWork(fromIdx);
    if(!next || !nextPreview){
      if(nextPreview) show(nextPreview, false);
      return;
    }
    const meta = next.seg.meta || {};
    const vid = vimeoIdFromEmbedUrl(meta.video_embed_url || '');
    const rec = moveFromVimeoId(vid) || {};
    if(nextThumb) nextThumb.src = rec.thumbnail_url || '/assets/branding/Desktop Poster.webp';
    if(nextLabel) nextLabel.textContent = meta.move_name ? meta.move_name : 'Next';
    show(nextPreview, true);
    if(nextEl){
      nextEl.textContent = meta.move_name ? `WORK — ${meta.move_name}` : kindLabel(next.seg.kind);
    }
  }

  function setBadgesForSegment(seg){
    if(!seg) return;
    const meta = seg.meta || {};
    if(segKindEl) segKindEl.textContent = kindLabel(seg.kind);
    if(stageEl) stageEl.textContent = meta.stage_index ? `Stage ${meta.stage_index}/${meta.stage_count||''}` : 'Stage —';
    if(moveEl) moveEl.textContent = meta.move_name ? meta.move_name : 'Move —';
  }

  function populateDemoSelect(){
    if(!demoSel) return;

    const mine = getMyWorkouts().filter(w => w && w.mode === 'online');

    demoSel.innerHTML = '';

    const og1 = document.createElement('optgroup');
    og1.label = 'Demos';
    demos.forEach(d=>{
      const opt = document.createElement('option');
      opt.value = `demo:${d.id}`;
      opt.textContent = d.title;
      og1.appendChild(opt);
    });
    demoSel.appendChild(og1);

    const og2 = document.createElement('optgroup');
    og2.label = 'My Workouts (local)';
    mine.forEach(w=>{
      const opt = document.createElement('option');
      opt.value = `my:${w.id}`;
      opt.textContent = w.name || 'Untitled Workout';
      og2.appendChild(opt);
    });
    demoSel.appendChild(og2);

    demoSel.addEventListener('change', ()=> loadSourceById(demoSel.value));

    // If src query provided, select it
    const q = new URLSearchParams(location.search);
    const want = q.get('src');
    if(want){
      demoSel.value = want;
    }
  }

  function resolveSource(id){
    const raw = String(id||'').trim();
    if(raw.startsWith('my:')){
      const wid = raw.slice(3);
      const w = getMyWorkoutById(wid);
      if(w) return {id: raw, title: w.name||'My Workout', cap_suggestion_min: w.cap_suggestion_min||42, segments: w.segments||[]};
    }
    if(raw.startsWith('demo:')){
      const did = raw.slice(5);
      const d = demos.find(x=>x.id===did);
      if(d) return {id: raw, title: d.title, cap_suggestion_min: d.cap_suggestion_min||42, segments: d.segments||[]};
    }
    // fallback
    const d = demos[0];
    return d ? {id:`demo:${d.id}`, title:d.title, cap_suggestion_min:d.cap_suggestion_min||42, segments:d.segments||[]} : null;
  }

  function loadSourceById(id){
    const src = resolveSource(id);
    if(!src) return;

    activeSourceId = src.id;
    baseSegments = cloneSegments(src.segments || []);
    segments = cloneSegments(baseSegments);
    capUndoSnapshot = null;
    if(undoCapBtn) show(undoCapBtn, false);

    if(capMin) capMin.value = String(src.cap_suggestion_min || 42);

    // initial video = first WORK segment (if any)
    const firstWork = segments.find(s=>s.kind==='WORK');
    lastWorkSeg = firstWork || null;
    setVideoForSegment(firstWork || segments[0]);
    if(firstWork) refreshEquipUIForSegment(firstWork);

    renderTimeline(0);
    updateTotals('');
    buildEngine();
  }

  function maybeCountdownBeep(idx, segRemaining){
    if(!countdownChk || !countdownChk.checked) return;
    const sec = Math.ceil(segRemaining);
    if(sec >= 1 && sec <= 3){
      if(lastCountdown.idx !== idx || lastCountdown.sec !== sec){
        lastCountdown = {idx, sec};
        // slightly softer than transitions
        beep({freq: 880, duration: 0.06, volume: getBeepVolume()*0.55});
      }
    }
  }

  function buildEngine(){
    if(engine){
      engine.pause();
      engine = null;
    }
    const speed = Number(speedSel?.value || 1) || 1;
    engine = new HiitTimerEngine(segments, {
      timeScale: speed,
      onSegment: ({idx, segment})=>{
        setVideoForSegment(segment, idx);
        setBadgesForSegment(segment);
        setRunModeForSegment(segment);
        updateNextPreview(idx);
        renderTimeline(idx);
        if(idx>0){
          const k = segment.kind;
          if(k==='WORK') beepPattern('work');
          else if(k==='REST') beepPattern('rest');
          else if(k==='MOVE_TRANSITION_A') beepPattern('move_a');
          else if(k==='MOVE_TRANSITION_B') beepPattern('move_b');
          else if(k==='STATION_STAGE_TRANSITION') beepPattern('station');
        }
        // refresh equipment only when move changes
        if(segment.kind==='WORK') refreshEquipUIForSegment(segment);
      },
      onTick: ({idx, segRemaining})=>{
        if(clockEl) clockEl.textContent = fmtTime(segRemaining);
        maybeCountdownBeep(idx, segRemaining);
      },
      onComplete: ()=>{
        if(clockEl) clockEl.textContent = '00:00';
        if(segKindEl) segKindEl.textContent = 'Complete';
        if(nextEl) nextEl.textContent = '—';
        beepPattern('complete');
        setWakeLockWanted(false);
      }
    });
  }

  // Buttons
  if(startBtn){
    startBtn.addEventListener('click', ()=>{
      setVolFromUI();
      unlockAudio();
      if(keepAwakeChk && keepAwakeChk.checked){
        setWakeLockWanted(true);
      }
      beepPattern('start');
      engine?.start();
    });
  }
  if(pauseBtn){
    pauseBtn.addEventListener('click', ()=>{
      if(!engine) return;
      if(engine.isRunning()){
        engine.pause();
        pauseBtn.textContent = 'Resume';
        setWakeLockWanted(false);
      }else{
        setVolFromUI();
        unlockAudio();
        if(keepAwakeChk && keepAwakeChk.checked){
          setWakeLockWanted(true);
        }
        engine.start();
        pauseBtn.textContent = 'Pause';
      }
    });
  }
  if(skipBtn){
    skipBtn.addEventListener('click', ()=> engine?.skip());
  }
  if(resetBtn){
    resetBtn.addEventListener('click', ()=>{
      engine?.reset();
      pauseBtn && (pauseBtn.textContent = 'Pause');
      setWakeLockWanted(false);
      renderTimeline(0);
      updateTotals('');
      if(segments[0]){
        setBadgesForSegment(segments[0]);
        setRunModeForSegment(segments[0]);
        setVideoForSegment(segments[0]);
        updateNextPreview(0);
      }
    });
  }

  // Autopause on background
  document.addEventListener('visibilitychange', ()=>{
    if(!autoPauseChk || !autoPauseChk.checked) return;
    if(document.hidden && engine && engine.isRunning()){
      engine.pause();
      if(pauseBtn) pauseBtn.textContent = 'Resume';
      setWakeLockWanted(false);
      injectBanner('Paused because the app went to the background. Tap Resume when you’re ready.', 'warn');
    }
  });

  // Populate demo options + optional builder links
  populateDemoSelect();
  if(builderBtn) builderBtn.addEventListener('click', ()=> location.href = '/app/timer/builder/');
  if(myBtn) myBtn.addEventListener('click', ()=> location.href = '/app/timer/my-workouts/');



  // Cap-filler UI behavior (member timer)
  function syncCapFillAll(){
    if(!capFillAllChk) return;
    const any = (capFillGroupChks||[]).some(el => el && el.checked);
    capFillAllChk.checked = !any;
  }
  if(capFillAllChk){
    capFillAllChk.addEventListener('change', ()=>{
      if(capFillAllChk.checked){
        (capFillGroupChks||[]).forEach(el => { if(el) el.checked = false; });
      }
      syncCapFillAll();
    });
  }
  (capFillGroupChks||[]).forEach(el=>{
    if(!el) return;
    el.addEventListener('change', ()=> syncCapFillAll());
  });
  syncCapFillAll();

  function readCapFillOpts(){
    const secPer = clampInt(capFillSecIn?.value, 10, 180, 30);
    const groups = (capFillGroupChks||[]).filter(c=>c && c.checked).map(c=>String(c.value||'').trim()).filter(Boolean);
    const useAll = !!capFillAllChk?.checked || groups.length===0;
    return {
      sec_per_move: secPer,
      groups,
      use_all: useAll,
      balance: !!capFillBalanceChk?.checked,
      strict: !!capFillStrictChk?.checked,
      no_repeats: !!capFillNoRepeatChk?.checked
    };
  }

  function buildCapFillerSegments(deltaSec){
    const opts = readCapFillOpts();
    const basePool = Array.isArray(_movesCatalog) ? _movesCatalog.slice() : [];
    if(!basePool.length){
      return [{kind:'WORK', duration_sec: Math.max(1, Math.floor(deltaSec||1)), meta:{move_name:'Cap Filler'}}];
    }

    // Filter by muscle-group selection (derived from move titles)
    let pool = basePool;
    const selected = (opts.groups||[]).map(g=>String(g||'').toLowerCase().trim()).filter(Boolean);
    if(!opts.use_all && selected.length){
      const filtered = basePool.filter(m=>{
        const gs = moveGroupSet(m);
        if(opts.strict) return selected.every(g => gs.has(g));
        return selected.some(g => gs.has(g));
      });
      pool = filtered.length ? filtered : basePool;
    }

    const per = clampInt(opts.sec_per_move, 10, 180, 30);
    let remaining = Math.max(1, Math.floor(Number(deltaSec||1)));

    // Optional round-robin by selected groups
    let groupPools = null;
    if(opts.balance && !opts.strict && !opts.use_all && selected.length>1){
      groupPools = {};
      selected.forEach(g=>{
        groupPools[g] = pool.filter(m=> moveGroupSet(m).has(g));
      });
    }

    const used = new Set();
    const out = [];
    let i = 0;

    while(remaining > 0){
      const dur = Math.min(per, remaining);
      let pickFrom = pool;

      if(groupPools){
        const g = selected[i % selected.length];
        const gp = groupPools[g] || [];
        if(gp.length) pickFrom = gp;
      }

      let chosen = null;
      for(let tries=0; tries<60; tries++){
        const cand = pickFrom[Math.floor(Math.random()*pickFrom.length)];
        const id = String(cand?.video_id || '');
        if(!id) continue;
        if(opts.no_repeats && used.has(id) && pickFrom.length>1) continue;
        chosen = cand;
        break;
      }
      if(!chosen) chosen = pickFrom[Math.floor(Math.random()*pickFrom.length)];

      const vid = String(chosen?.video_id || '');
      if(vid) used.add(vid);

      out.push({
        kind:'WORK',
        duration_sec: dur,
        meta:{
          mode:'online',
          move_name: String(chosen?.title || 'Cap Filler'),
          video_embed_url: String(chosen?.embed_url || ''),
          rest_type: 'Cap Filler',
          is_cap_filler: true
        }
      });

      remaining -= dur;
      i++;
    }

    return out;
  }

  // Volume wire-up
  syncVolUI();
  if(volRange) volRange.addEventListener('input', setVolFromUI);
  if(testBeepBtn){
    testBeepBtn.addEventListener('click', ()=>{
      setVolFromUI();
      ensureAudio();
      beepPattern('work');
    });
  }

  // Apply cap / undo cap
  if(applyCapBtn){
    applyCapBtn.addEventListener('click', ()=>{
      const minutes = clampInt(capMin?.value, 1, 300, 42);
      const cap = minutes*60;
      const pool = String(capPool?.value || 'all');
      const under_strategy = String(capUnder?.value || 'adjust');

      capUndoSnapshot = {segments: cloneSegments(segments), note: '', cap, pool, under_strategy, ts: Date.now()};
      const finisher_builder = (under_strategy==='finisher') ? (delta)=> buildCapFillerSegments(delta) : null;
      const res = applyTimeCap(baseSegments, cap, pool, {under_strategy, finisher_name:'Cap Filler', finisher_builder});
      segments = cloneSegments(res.segments);
      updateTotals(res.note);
      renderTimeline(0);
      buildEngine();
      if(undoCapBtn) show(undoCapBtn, true);
      injectBanner(res.note, 'info');
    });
  }
  if(undoCapBtn){
    undoCapBtn.addEventListener('click', ()=>{
      if(!capUndoSnapshot) return;
      segments = cloneSegments(capUndoSnapshot.segments);
      capUndoSnapshot = null;
      updateTotals('Cap undone.');
      renderTimeline(0);
      buildEngine();
      show(undoCapBtn, false);
      injectBanner('Time cap undone.', 'info');
    });
  }

  // Initial load
  if(demoSel && demoSel.value){
    loadSourceById(demoSel.value);
  }else{
    const first = demos[0];
    if(first) loadSourceById(`demo:${first.id}`);
  }
}



async function pageMemberTimerBuilder(){
  await loadMovesCatalog();

  const moves = Array.isArray(_movesCatalog) ? _movesCatalog.slice() : [];
  moves.sort((a,b)=> String(a.title||'').localeCompare(String(b.title||'')));

  const nameIn = qs('[data-name]');
  const stageIn = qs('[data-stage-count]');
  const movesIn = qs('[data-moves-per-stage]');
  const roundsIn = qs('[data-rounds-per-stage]');
  const workMM = qs('[data-work-mm]');
  const workSS = qs('[data-work-ss]');
  const restMM = qs('[data-rest-mm]');
  const restSS = qs('[data-rest-ss]');
  const moveTransMM = qs('[data-move-trans-mm]');
  const moveTransSS = qs('[data-move-trans-ss]');
  const stageTransMM = qs('[data-stage-trans-mm]');
  const stageTransSS = qs('[data-stage-trans-ss]');
  const warmupMM = qs('[data-warmup-mm]');
  const warmupSS = qs('[data-warmup-ss]');
  const cooldownMM = qs('[data-cooldown-mm]');
  const cooldownSS = qs('[data-cooldown-ss]');
  const noRepeatChk = qs('[data-no-repeats]');
  const avoidIn = qs('[data-avoid-words]');

  const randAllChk = qs('[data-rand-all]');
  const randGroupChks = qsa('[data-rand-group]');
  const randBalanceChk = qs('[data-rand-balance]');
  const randMatchAllChk = qs('[data-rand-match-all]');

  const slotsWrap = qs('[data-slots]');
  const previewWrap = qs('[data-preview]');
  const exportBox = qs('[data-export]');
  const importBox = qs('[data-import]');

  const btnRender = qs('[data-render-slots]');
  const btnRandom = qs('[data-randomize]');
  const btnGenerate = qs('[data-generate]');
  const btnSave = qs('[data-save]');
  const btnStart = qs('[data-start-now]');
  const btnImport = qs('[data-import-btn]');

  const slotState = new Map(); // key -> video_id

  // Random filter UI behavior
  function syncRandAll(){
    if(!randAllChk) return;
    const any = (randGroupChks||[]).some(el => el && el.checked);
    randAllChk.checked = !any;
  }
  if(randAllChk){
    randAllChk.addEventListener('change', ()=>{
      if(randAllChk.checked){
        (randGroupChks||[]).forEach(el => { if(el) el.checked = false; });
      }
      syncRandAll();
    });
  }
  (randGroupChks||[]).forEach(el=>{
    if(!el) return;
    el.addEventListener('change', ()=>{
      // Any selection turns off "All" automatically
      syncRandAll();
    });
  });
  syncRandAll();

  function moveOptionsHTML(selected){
    const s = String(selected||'');
    return ['<option value="">— Select move —</option>'].concat(
      moves.map(m=>{
        const id = String(m.video_id||'');
        const t = escapeHTML(String(m.title||'Move'));
        return `<option value="${id}" ${id===s?'selected':''}>${t}</option>`;
      })
    ).join('');
  }


  function readMMSS(mmEl, ssEl, defSec){
    const d = Math.max(0, Math.floor(Number(defSec||0)));
    const defMM = Math.floor(d/60);
    const defSS = d % 60;
    const mm = clampInt(mmEl?.value, 0, 999, defMM);
    const ss = clampInt(ssEl?.value, 0, 59, defSS);
    return mm*60 + ss;
  }

  function readParams(){
    return {
      name: String(nameIn?.value || '').trim(),
      stage_count: clampInt(stageIn?.value, 1, 20, 8),
      moves_per_stage: clampInt(movesIn?.value, 1, 6, 3),
      rounds_per_stage: clampInt(roundsIn?.value, 1, 10, 1),
      work_sec: clampInt(readMMSS(workMM, workSS, 60), 5, 600, 60),
      rest_sec: clampInt(readMMSS(restMM, restSS, 20), 0, 600, 20),
      move_trans_sec: clampInt(readMMSS(moveTransMM, moveTransSS, 0), 0, 120, 0),
      stage_trans_sec: clampInt(readMMSS(stageTransMM, stageTransSS, 50), 0, 600, 50),
      warmup_sec: clampInt(readMMSS(warmupMM, warmupSS, 0), 0, 1200, 0),
      cooldown_sec: clampInt(readMMSS(cooldownMM, cooldownSS, 0), 0, 1200, 0),
      no_repeats: !!noRepeatChk?.checked,
      avoid_words: String(avoidIn?.value || '').trim(),
      rand_all: !!randAllChk?.checked,
      rand_groups: (randGroupChks||[]).filter(c=>c && c.checked).map(c=>String(c.value||'').trim()).filter(Boolean),
      rand_balance: !!randBalanceChk?.checked,
      rand_match_all: !!randMatchAllChk?.checked
    };
  }

  function renderSlots(){
    if(!slotsWrap) return;
    const p = readParams();

    // keep old selections if still in range
    const next = new Map();
    for(let s=1; s<=p.stage_count; s++){
      for(let m=1; m<=p.moves_per_stage; m++){
        const key = `S${s}-M${m}`;
        if(slotState.has(key)) next.set(key, slotState.get(key));
      }
    }
    slotState.clear();
    next.forEach((v,k)=> slotState.set(k,v));

    slotsWrap.innerHTML = '';
    for(let s=1; s<=p.stage_count; s++){
      const block = document.createElement('div');
      block.className = 'builder-stage';
      block.innerHTML = `<div class="builder-stage-title">Stage ${s}</div><div class="builder-stage-grid" data-stage="${s}"></div>`;
      const grid = qs('[data-stage]', block);

      for(let m=1; m<=p.moves_per_stage; m++){
        const key = `S${s}-M${m}`;
        const sel = document.createElement('select');
        sel.className = 'input';
        sel.setAttribute('data-slot', key);
        sel.innerHTML = moveOptionsHTML(slotState.get(key));
        sel.addEventListener('change', ()=>{
          const v = String(sel.value||'');
          if(v) slotState.set(key, v); else slotState.delete(key);
        });

        const label = document.createElement('div');
        label.className = 'small muted';
        label.textContent = `Move ${m}`;

        const cell = document.createElement('div');
        cell.className = 'builder-slot';
        cell.appendChild(label);
        cell.appendChild(sel);
        grid.appendChild(cell);
      }

      slotsWrap.appendChild(block);
    }
  }

  function pickRandomMoves(){
    const p = readParams();
    const avoid = String(p.avoid_words||'').toLowerCase().split(',').map(x=>x.trim()).filter(Boolean);

    // Base pool (avoid words)
    const basePool = moves.filter(m=>{
      const t = String(m.title||'').toLowerCase();
      return avoid.every(w=>!t.includes(w));
    });
    if(!basePool.length) return;

    // Muscle-group filters
    const selected = (p.rand_groups||[]).map(g=>String(g||'').toLowerCase().trim()).filter(Boolean);
    const useAll = !!p.rand_all || selected.length === 0;
    const matchAll = !!p.rand_match_all;
    const balance = !!p.rand_balance && !matchAll && !useAll && selected.length > 1;

    let pool = basePool;
    if(!useAll){
      const filtered = basePool.filter(m=>{
        const gs = moveGroupSet(m);
        if(matchAll) return selected.every(g => gs.has(g));
        return selected.some(g => gs.has(g));
      });
      // If the filter is too strict, fall back to the base pool (avoid words only)
      pool = filtered.length ? filtered : basePool;
    }

    let groupPools = null;
    if(balance){
      groupPools = {};
      selected.forEach(g=>{
        groupPools[g] = pool.filter(m=> moveGroupSet(m).has(g));
      });
    }

    const used = new Set();
    let slotIndex = 0;
    for(let s=1; s<=p.stage_count; s++){
      for(let m=1; m<=p.moves_per_stage; m++){
        const key = `S${s}-M${m}`;
        let choice = null;
        // Optional round-robin across selected groups
        let pickFrom = pool;
        if(groupPools){
          const g = selected[slotIndex % selected.length];
          const gp = groupPools[g] || [];
          if(gp.length) pickFrom = gp;
        }
        slotIndex++;

        for(let tries=0; tries<60; tries++){
          const cand = pickFrom[Math.floor(Math.random()*pickFrom.length)];
          const id = String(cand.video_id||'');
          if(!id) continue;
          if(p.no_repeats && used.has(id)) continue;
          choice = id;
          break;
        }
        if(choice){
          slotState.set(key, choice);
          used.add(choice);
        }
      }
    }

    // refresh UI values
    if(slotsWrap){
      slotsWrap.querySelectorAll('select[data-slot]').forEach(sel=>{
        const key = sel.getAttribute('data-slot');
        if(key && slotState.has(key)) sel.value = slotState.get(key);
      });
    }
  }

  function buildWorkout(){
    const p = readParams();
    const id = `mw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,6)}`;
    const name = p.name || `HIIT56 Timer • ${isoDateLocal()}`;

    const segments = [];
    if(p.warmup_sec>0){
      segments.push({kind:'REST', duration_sec:p.warmup_sec, meta:{rest_type:'Warmup'}});
    }

    const stageCount = p.stage_count;
    for(let s=1; s<=stageCount; s++){
      for(let r=1; r<=p.rounds_per_stage; r++){
        for(let m=1; m<=p.moves_per_stage; m++){
          const slotKey = `S${s}-M${m}`;
          const vid = slotState.get(slotKey) || '';
          const rec = moveFromVimeoId(vid) || {};
          const moveName = rec.title || `Move ${m}`;
          const embed = rec.embed_url || '';
          segments.push({
            kind:'WORK',
            duration_sec:p.work_sec,
            meta:{
              stage_index:s,
              stage_count:stageCount,
              round_index:r,
              rounds_per_stage:p.rounds_per_stage,
              move_slot_index:m,
              move_slots_per_stage:p.moves_per_stage,
              move_name:moveName,
              video_embed_url:embed
            }
          });

          if(m < p.moves_per_stage && p.move_trans_sec>0){
            const kind = (m % 2 === 1) ? 'MOVE_TRANSITION_A' : 'MOVE_TRANSITION_B';
            segments.push({kind, duration_sec:p.move_trans_sec, meta:{rest_type:'Move Transition'}});
          }
        }
        if(r < p.rounds_per_stage && p.rest_sec>0){
          segments.push({kind:'REST', duration_sec:p.rest_sec, meta:{rest_type:'Round Rest'}});
        }
      }
      if(s < stageCount && p.stage_trans_sec>0){
        segments.push({kind:'STATION_STAGE_TRANSITION', duration_sec:p.stage_trans_sec, meta:{rest_type:'Stage Transition'}});
      }
    }

    if(p.cooldown_sec>0){
      segments.push({kind:'REST', duration_sec:p.cooldown_sec, meta:{rest_type:'Cooldown'}});
    }

    const total = computeTotalSec(segments);

    return {
      id,
      mode:'online',
      name,
      created_at: new Date().toISOString(),
      cap_suggestion_min: Math.max(1, Math.round(total/60)),
      params: p,
      segments
    };
  }

  function renderPreview(workout){
    if(previewWrap){
      previewWrap.innerHTML = `
        <div class="small muted">Total time</div>
        <div class="h2">${fmtTime(computeTotalSec(workout.segments))}</div>
        <div class="small muted">Segments</div>
        <div class="small">${workout.segments.slice(0,20).map(s=>`${kindLabel(s.kind)} • ${fmtTime(s.duration_sec)}`).join('<br>')}${workout.segments.length>20?'<br>…':''}</div>
      `;
    }
    if(exportBox){
      exportBox.value = JSON.stringify(workout, null, 2);
    }
  }

  let lastGenerated = null;

  if(btnRender) btnRender.addEventListener('click', renderSlots);
  if(btnRandom) btnRandom.addEventListener('click', ()=>{
    pickRandomMoves();
    injectBanner('Moves randomized.', 'info');
  });
  if(btnGenerate) btnGenerate.addEventListener('click', ()=>{
    lastGenerated = buildWorkout();
    renderPreview(lastGenerated);
    injectBanner('Preview generated.', 'info');
  });
  if(btnSave) btnSave.addEventListener('click', ()=>{
    if(!lastGenerated){
      lastGenerated = buildWorkout();
      renderPreview(lastGenerated);
    }
    upsertMyWorkout(lastGenerated);
    injectBanner('Saved to My Workouts (local).', 'info');
  });
  if(btnStart) btnStart.addEventListener('click', ()=>{
    if(!lastGenerated){
      lastGenerated = buildWorkout();
      renderPreview(lastGenerated);
    }
    upsertMyWorkout(lastGenerated);
    location.href = `/app/timer/?src=my:${lastGenerated.id}`;
  });
  if(btnImport) btnImport.addEventListener('click', ()=>{
    const raw = String(importBox?.value||'').trim();
    if(!raw) return;
    try{
      const obj = JSON.parse(raw);
      if(!obj || obj.mode!=='online' || !Array.isArray(obj.segments)) throw new Error('Invalid workout format');
      obj.id = obj.id || `mw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,6)}`;
      obj.created_at = obj.created_at || new Date().toISOString();
      upsertMyWorkout(obj);
      injectBanner('Imported into My Workouts.', 'info');
    }catch(e){
      injectBanner('Import failed: ' + e.message, 'warn');
    }
  });

  // Defaults
  renderSlots();
}

async function pageMemberMyWorkouts(){
  const listEl = qs('[data-list]');
  const importBox = qs('[data-import]');
  const importBtn = qs('[data-import-btn]');

  function render(){
    if(!listEl) return;
    const items = getMyWorkouts().filter(w => w && w.mode === 'online');
    if(!items.length){
      listEl.innerHTML = '<div class="card"><div class="small muted">No saved workouts yet.</div><div class="row"><a class="btn" href="/app/timer/builder/">Build one</a></div></div>';
      return;
    }
    listEl.innerHTML = '';
    items.forEach(w=>{
      const card = document.createElement('div');
      card.className = 'card';
      const total = fmtTime(computeTotalSec(w.segments||[]));
      card.innerHTML = `
        <div class="row row-between">
          <div>
            <div class="h3">${escapeHTML(w.name||'Untitled')}</div>
            <div class="small muted">${total} • ${escapeHTML(String(w.created_at||'').slice(0,10))}</div>
          </div>
          <div class="row">
            <button class="btn btn-small" data-start="${escapeHTML(w.id)}">Start</button>
            <button class="btn btn-small btn-ghost" data-export="${escapeHTML(w.id)}">Export</button>
            <button class="btn btn-small btn-ghost" data-del="${escapeHTML(w.id)}">Delete</button>
          </div>
        </div>
      `;
      listEl.appendChild(card);
    });

    listEl.querySelectorAll('[data-start]').forEach(b=>{
      b.addEventListener('click', ()=>{
        const id = b.getAttribute('data-start');
        location.href = `/app/timer/?src=my:${id}`;
      });
    });
    listEl.querySelectorAll('[data-del]').forEach(b=>{
      b.addEventListener('click', ()=>{
        const id = b.getAttribute('data-del');
        deleteMyWorkout(id);
        render();
        injectBanner('Deleted workout.', 'info');
      });
    });
    listEl.querySelectorAll('[data-export]').forEach(b=>{
      b.addEventListener('click', ()=>{
        const id = b.getAttribute('data-export');
        const w = getMyWorkoutById(id);
        if(!w) return;
        const raw = JSON.stringify(w, null, 2);
        navigator.clipboard?.writeText(raw).then(()=>{
          injectBanner('Copied workout JSON to clipboard.', 'info');
        }).catch(()=>{
          injectBanner('Copy failed — you can still select and copy manually.', 'warn');
        });
      });
    });
  }

  if(importBtn){
    importBtn.addEventListener('click', ()=>{
      const raw = String(importBox?.value||'').trim();
      if(!raw) return;
      try{
        const obj = JSON.parse(raw);
        if(!obj || obj.mode!=='online' || !Array.isArray(obj.segments)) throw new Error('Invalid workout format');
        obj.id = obj.id || `mw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,6)}`;
        obj.created_at = obj.created_at || new Date().toISOString();
        upsertMyWorkout(obj);
        importBox.value = '';
        render();
        injectBanner('Imported workout.', 'info');
      }catch(e){
        injectBanner('Import failed: ' + e.message, 'warn');
      }
    });
  }

  render();
}

async function pageBizGymTimerBuilder(){
  await loadMovesCatalog();
  await loadEquipmentCatalog();

  const tenant = getTenant() || {slug:'global', name:'HIIT56'};
  const tenantSlug = tenant.slug || 'global';
  const role = getRole();

  const moves = Array.isArray(_movesCatalog) ? _movesCatalog.slice() : [];
  moves.sort((a,b)=> String(a.title||'').localeCompare(String(b.title||'')));

  const nameIn = qs('[data-name]');
  const stationIn = qs('[data-station-count]');
  const peopleIn = qs('[data-people-per-station]');
  const movesPerIn = qs('[data-moves-per-station]');
  const workMM = qs('[data-work-mm]');
  const workSS = qs('[data-work-ss]');
  const restMM = qs('[data-rest-mm]');
  const restSS = qs('[data-rest-ss]');
  const roundsIn = qs('[data-rounds-per-move]');
  const moveTransMM = qs('[data-move-trans-mm]');
  const moveTransSS = qs('[data-move-trans-ss]');
  const stationTransMM = qs('[data-station-trans-mm]');
  const stationTransSS = qs('[data-station-trans-ss]');
  const loopsIn = qs('[data-loops]');
  const restBetweenLoopsMM = qs('[data-rest-between-loops-mm]');
  const restBetweenLoopsSS = qs('[data-rest-between-loops-ss]');
  const noRepeatChk = qs('[data-no-repeats]');
  const avoidIn = qs('[data-avoid-words]');

  const slotsWrap = qs('[data-stations]');
  const previewWrap = qs('[data-preview]');
  const exportBox = qs('[data-export]');
  const importBox = qs('[data-import]');

  const btnRender = qs('[data-render]');
  const btnRandom = qs('[data-randomize]');
  const btnGenerate = qs('[data-generate]');
  const btnSaveTpl = qs('[data-save-template]');
  const btnSaveMod = qs('[data-save-mod]');
  const btnStart = qs('[data-start-now]');
  const btnImport = qs('[data-import-btn]');

  const slotState = new Map(); // key -> video_id

  function moveOptionsHTML(selected){
    const s = String(selected||'');
    return ['<option value="">— Select move —</option>'].concat(
      moves.map(m=>{
        const id = String(m.video_id||'');
        const t = escapeHTML(String(m.title||'Move'));
        return `<option value="${id}" ${id===s?'selected':''}>${t}</option>`;
      })
    ).join('');
  }


  function readMMSS(mmEl, ssEl, defSec){
    const d = Math.max(0, Math.floor(Number(defSec||0)));
    const defMM = Math.floor(d/60);
    const defSS = d % 60;
    const mm = clampInt(mmEl?.value, 0, 999, defMM);
    const ss = clampInt(ssEl?.value, 0, 59, defSS);
    return mm*60 + ss;
  }

  function readParams(){
    return {
      title: String(nameIn?.value||'').trim() || `Gym Timer • ${isoDateLocal()}`,
      station_count: clampInt(stationIn?.value, 1, 20, 6),
      people_per_station: clampInt(peopleIn?.value, 0, 50, 0),
      moves_per_station: clampInt(movesPerIn?.value, 1, 2, 2),
      work_sec: clampInt(readMMSS(workMM, workSS, 60), 5, 600, 60),
      rest_sec: clampInt(readMMSS(restMM, restSS, 10), 0, 600, 10),
      rounds_per_move: clampInt(roundsIn?.value, 1, 20, 3),
      move_trans_sec: clampInt(readMMSS(moveTransMM, moveTransSS, 10), 0, 300, 10),
      station_trans_sec: clampInt(readMMSS(stationTransMM, stationTransSS, 30), 0, 600, 30),
      loops: clampInt(loopsIn?.value, 1, 20, 1),
      rest_between_loops: clampInt(readMMSS(restBetweenLoopsMM, restBetweenLoopsSS, 60), 0, 1200, 60),
      no_repeats: !!noRepeatChk?.checked,
      avoid_words: String(avoidIn?.value||'').trim()
    };
  }

  function renderStations(){
    if(!slotsWrap) return;
    const p = readParams();

    const next = new Map();
    for(let s=1; s<=p.station_count; s++){
      for(let m=1; m<=p.moves_per_station; m++){
        const key = `ST${s}-${m===1?'A':'B'}`;
        if(slotState.has(key)) next.set(key, slotState.get(key));
      }
    }
    slotState.clear();
    next.forEach((v,k)=> slotState.set(k,v));

    slotsWrap.innerHTML = '';
    for(let s=1; s<=p.station_count; s++){
      const card = document.createElement('div');
      card.className = 'builder-station';
      card.innerHTML = `<div class="builder-station-title">Station ${s}</div><div class="builder-station-grid" data-st="${s}"></div>`;
      const grid = qs('[data-st]', card);

      const cellA = document.createElement('div');
      cellA.className = 'builder-slot';
      cellA.innerHTML = `<div class="small muted">Move A</div><select class="input" data-slot="ST${s}-A">${moveOptionsHTML(slotState.get(`ST${s}-A`))}</select>`;
      grid.appendChild(cellA);

      if(p.moves_per_station===2){
        const cellB = document.createElement('div');
        cellB.className = 'builder-slot';
        cellB.innerHTML = `<div class="small muted">Move B</div><select class="input" data-slot="ST${s}-B">${moveOptionsHTML(slotState.get(`ST${s}-B`))}</select>`;
        grid.appendChild(cellB);
      }

      slotsWrap.appendChild(card);
    }

    slotsWrap.querySelectorAll('select[data-slot]').forEach(sel=>{
      sel.addEventListener('change', ()=>{
        const key = sel.getAttribute('data-slot');
        const v = String(sel.value||'');
        if(!key) return;
        if(v) slotState.set(key, v); else slotState.delete(key);
      });
    });
  }

  function pickRandom(){
    const p = readParams();
    const avoid = String(p.avoid_words||'').toLowerCase().split(',').map(x=>x.trim()).filter(Boolean);
    const pool = moves.filter(m=>{
      const t = String(m.title||'').toLowerCase();
      return avoid.every(w=>!t.includes(w));
    });
    if(!pool.length) return;

    const used = new Set();
    for(let s=1; s<=p.station_count; s++){
      for(let m=1; m<=p.moves_per_station; m++){
        const key = `ST${s}-${m===1?'A':'B'}`;
        let choice = null;
        for(let tries=0; tries<30; tries++){
          const cand = pool[Math.floor(Math.random()*pool.length)];
          const id = String(cand.video_id||'');
          if(!id) continue;
          if(p.no_repeats && used.has(id)) continue;
          choice = id;
          break;
        }
        if(choice){
          slotState.set(key, choice);
          used.add(choice);
        }
      }
    }

    if(slotsWrap){
      slotsWrap.querySelectorAll('select[data-slot]').forEach(sel=>{
        const key = sel.getAttribute('data-slot');
        if(key && slotState.has(key)) sel.value = slotState.get(key);
      });
    }
  }

  function buildProgram(){
    const p = readParams();
    const id = `gt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,6)}`;

    // Stations list (for UI grid)
    const stations = [];
    for(let s=1; s<=p.station_count; s++){
      const a = moveFromVimeoId(slotState.get(`ST${s}-A`)) || {};
      const b = moveFromVimeoId(slotState.get(`ST${s}-B`)) || {};
      stations.push({
        station: s,
        people: p.people_per_station || '',
        move_a: a.title || '—',
        move_b: p.moves_per_station===2 ? (b.title || '—') : ''
      });
    }

    // Segments (for engine)
    const segments = [];
    for(let loop=1; loop<=p.loops; loop++){
      for(let s=1; s<=p.station_count; s++){
        const movesSlots = p.moves_per_station===2 ? ['A','B'] : ['A'];
        for(let mi=0; mi<movesSlots.length; mi++){
          const slot = movesSlots[mi];
          const rec = moveFromVimeoId(slotState.get(`ST${s}-${slot}`)) || {};
          const moveName = rec.title || `Station ${s} ${slot}`;
          for(let r=1; r<=p.rounds_per_move; r++){
            segments.push({
              kind:'WORK',
              duration_sec:p.work_sec,
              meta:{
                rotation_index:s,
                rotation_count:p.station_count,
                move_slot_index: mi+1,
                move_slots_per_station: movesSlots.length,
                round_index:r,
                rounds_per_move:p.rounds_per_move,
                move_name: moveName
              }
            });
            if(r < p.rounds_per_move && p.rest_sec>0){
              segments.push({kind:'REST', duration_sec:p.rest_sec, meta:{rest_type:'Round Rest'}});
            }
          }
          if(mi < movesSlots.length-1 && p.move_trans_sec>0){
            segments.push({kind:'MOVE_TRANSITION_A', duration_sec:p.move_trans_sec, meta:{rest_type:'Move Transition'}});
          }
        }
        if(s < p.station_count && p.station_trans_sec>0){
          segments.push({kind:'STATION_STAGE_TRANSITION', duration_sec:p.station_trans_sec, meta:{rest_type:'Station Transition'}});
        }
      }
      if(loop < p.loops && p.rest_between_loops>0){
        segments.push({kind:'REST', duration_sec:p.rest_between_loops, meta:{rest_type:'Round Rest'}});
      }
    }

    return {
      id,
      mode:'gym',
      title: p.title,
      created_at: new Date().toISOString(),
      cap_suggestion_min: Math.max(1, Math.round(computeTotalSec(segments)/60)),
      params: p,
      stations,
      segments
    };
  }

  function renderPreview(obj){
    if(previewWrap){
      previewWrap.innerHTML = `
        <div class="small muted">Total time</div>
        <div class="h2">${fmtTime(computeTotalSec(obj.segments))}</div>
        <div class="small muted">Stations</div>
        <div class="small">${obj.stations.map(s=>`Station ${s.station}: ${escapeHTML(s.move_a)}${s.move_b?` / ${escapeHTML(s.move_b)}`:''}`).slice(0,10).join('<br>')}${obj.stations.length>10?'<br>…':''}</div>
      `;
    }
    if(exportBox) exportBox.value = JSON.stringify(obj, null, 2);
  }

  let lastGenerated = null;

  // role-based save buttons
  const isAdmin = (role === ROLES.BIZ_ADMIN || role === ROLES.SUPER_ADMIN);
  show(btnSaveTpl, isAdmin);
  show(btnSaveMod, !isAdmin);

  if(btnRender) btnRender.addEventListener('click', renderStations);
  if(btnRandom) btnRandom.addEventListener('click', ()=>{
    pickRandom();
    injectBanner('Moves randomized.', 'info');
  });
  if(btnGenerate) btnGenerate.addEventListener('click', ()=>{
    lastGenerated = buildProgram();
    renderPreview(lastGenerated);
    injectBanner('Preview generated.', 'info');
  });

  if(btnSaveTpl) btnSaveTpl.addEventListener('click', ()=>{
    if(!lastGenerated){
      lastGenerated = buildProgram();
      renderPreview(lastGenerated);
    }
    upsertBizGymTemplate(tenantSlug, lastGenerated);
    injectBanner('Saved as Template (local).', 'info');
  });
  if(btnSaveMod) btnSaveMod.addEventListener('click', ()=>{
    if(!lastGenerated){
      lastGenerated = buildProgram();
      renderPreview(lastGenerated);
    }
    upsertBizGymModToday(tenantSlug, lastGenerated);
    injectBanner(`Saved as Today’s Mod (${isoDateLocal()}) (local).`, 'info');
  });

  if(btnStart) btnStart.addEventListener('click', ()=>{
    if(!lastGenerated){
      lastGenerated = buildProgram();
      renderPreview(lastGenerated);
    }
    // Save first so the run page can load it
    if(isAdmin) upsertBizGymTemplate(tenantSlug, lastGenerated);
    else upsertBizGymModToday(tenantSlug, lastGenerated);

    const prefix = isAdmin ? 'tpl:' : 'mod:';
    location.href = `/biz/gym-timer/?src=${prefix}${lastGenerated.id}`;
  });

  if(btnImport) btnImport.addEventListener('click', ()=>{
    const raw = String(importBox?.value||'').trim();
    if(!raw) return;
    try{
      const obj = JSON.parse(raw);
      if(!obj || obj.mode!=='gym' || !Array.isArray(obj.segments) || !Array.isArray(obj.stations)) throw new Error('Invalid program format');
      obj.id = obj.id || `gt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,6)}`;
      obj.created_at = obj.created_at || new Date().toISOString();
      if(isAdmin) upsertBizGymTemplate(tenantSlug, obj);
      else upsertBizGymModToday(tenantSlug, obj);
      injectBanner('Imported program saved (local).', 'info');
    }catch(e){
      injectBanner('Import failed: ' + e.message, 'warn');
    }
  });

  renderStations();
}

async function pageBizGymTimer(){
  await loadEquipmentCatalog();
  await loadMovesCatalog();

  const tenant = getTenant() || {slug:'global', name:'HIIT56'};
  const tenantSlug = tenant.slug || 'global';

  const data = await loadJSON('/assets/data/timer_demos.json');
  const demos = (data.demos || []).filter(d => d.mode === 'gym');

  const demoSel = qs('[data-demo-select]');
  const capMin = qs('[data-cap-min]');
  const capPool = qs('[data-cap-pool]');
  const capUnder = qs('[data-cap-under]');
  const capFillAllChk = qs('[data-capfill-all]');
  const capFillGroupChks = qsa('[data-capfill-group]');
  const capFillBalanceChk = qs('[data-capfill-balance]');
  const capFillStrictChk = qs('[data-capfill-strict]');
  const capFillNoRepeatChk = qs('[data-capfill-norepeat]');
  const capFillSecIn = qs('[data-capfill-sec]');
  const speedSel = qs('[data-speed]');
  const totalTime = qs('[data-total-time]');
  const capStatus = qs('[data-cap-status]');
  const volRange = qs('[data-beep-volume]');
  const countdownChk = qs('[data-countdown-beeps]');
  const keepAwakeChk = qs('[data-keep-awake]');
  const autoPauseChk = qs('[data-auto-pause-hidden]');
  const fullscreenBtn = qs('[data-fullscreen]');
  const builderBtn = qs('[data-open-builder]');

  const startBtn = qs('[data-start]');
  const pauseBtn = qs('[data-pause]');
  const skipBtn = qs('[data-skip]');
  const resetBtn = qs('[data-reset]');
  const applyCapBtn = qs('[data-apply-cap]');
  const undoCapBtn = qs('[data-undo-cap]');
  const testBeepBtn = qs('[data-test-beep]');

  const clockEl = qs('[data-clock]');
  const segKindEl = qs('[data-seg-kind]');
  const rotEl = qs('[data-rotation]');
  const roundEl = qs('[data-round]');
  const moveEl = qs('[data-move]');
  const nextEl = qs('[data-next]');
  const timelineEl = qs('[data-timeline]');
  const stationGrid = qs('[data-station-grid]');

  // Station meta storage (equipment + notes)
  const STATION_META_KEY = 'hiit56_gym_station_meta_v1';
  let stationMeta = readJSON(STATION_META_KEY, {}) || {};

  const KIND_CLASS = {WORK:'kind-work',REST:'kind-rest',MOVE_TRANSITION_A:'kind-move-a',MOVE_TRANSITION_B:'kind-move-b',STATION_STAGE_TRANSITION:'kind-station'};

  // Preferences
  const COUNTDOWN_KEY = 'hiit56_timer_countdown_beeps';
  const AWAKE_KEY = 'hiit56_timer_keep_awake';
  const AUTOPAUSE_KEY = 'hiit56_timer_autopause_hidden';

  function readBool(key, fallback){
    const raw = localStorage.getItem(key);
    if(raw === null) return !!fallback;
    return raw === '1' || raw === 'true';
  }
  function writeBool(key, val){
    localStorage.setItem(key, val ? '1' : '0');
  }

  if(countdownChk){ countdownChk.checked = readBool(COUNTDOWN_KEY, true); countdownChk.addEventListener('change', ()=> writeBool(COUNTDOWN_KEY, countdownChk.checked)); }
  if(keepAwakeChk){ keepAwakeChk.checked = readBool(AWAKE_KEY, true); keepAwakeChk.addEventListener('change', ()=> writeBool(AWAKE_KEY, keepAwakeChk.checked)); }
  if(autoPauseChk){ autoPauseChk.checked = readBool(AUTOPAUSE_KEY, true); autoPauseChk.addEventListener('change', ()=> writeBool(AUTOPAUSE_KEY, autoPauseChk.checked)); }

  // Timer state
  let baseSegments = [];
  let segments = [];
  let baseStations = [];
  let stations = [];
  let engine = null;
  let capUndoSnapshot = null;
  let activeSourceId = null;
  let lastCountdown = {idx:null, sec:null};

  function setVolFromUI(){
    if(!volRange) return;
    const v = clamp(Number(volRange.value||0)/100, 0, 1);
    setBeepVolume(v);
  }
  function syncVolUI(){
    if(!volRange) return;
    volRange.value = String(Math.round(getBeepVolume()*100));
  }

  function updateTotals(note=''){
    if(totalTime) totalTime.textContent = fmtTime(computeTotalSec(segments));
    if(capStatus) capStatus.textContent = note || '';
  }

  function setBadgesForSegment(seg){
    if(!seg) return;
    const meta = seg.meta || {};
    if(segKindEl) segKindEl.textContent = kindLabel(seg.kind);
    if(rotEl) rotEl.textContent = meta.rotation_index ? `Station ${meta.rotation_index}/${meta.rotation_count||''}` : 'Station —';
    if(roundEl) roundEl.textContent = meta.round_index ? `Round ${meta.round_index}/${meta.rounds_per_move||''}` : 'Round —';
    if(moveEl) moveEl.textContent = meta.move_name ? meta.move_name : 'Move —';
  }

  function findNextSummary(fromIdx){
    for(let i=fromIdx+1;i<segments.length;i++){
      const s = segments[i];
      if(!s) continue;
      if(s.kind==='WORK'){
        const meta = s.meta||{};
        return meta.move_name ? `WORK — ${meta.move_name}` : 'WORK';
      }
      if(s.kind==='REST') return 'REST';
      if(s.kind==='MOVE_TRANSITION_A'||s.kind==='MOVE_TRANSITION_B') return 'MOVE TRANSITION';
      if(s.kind==='STATION_STAGE_TRANSITION') return 'STATION TRANSITION';
    }
    return 'End';
  }

  function renderTimeline(activeIdx){
    if(!timelineEl) return;
    timelineEl.innerHTML = '';
    segments.slice(0, 22).forEach((s,i)=>{
      const item = document.createElement('div');
      item.className = 'timeline-item ' + (KIND_CLASS[s.kind]||'');
      if(i===activeIdx) item.classList.add('active');
      const left = document.createElement('div');
      left.className = 'left';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = kindLabel(s.kind) + (s.kind==='WORK' && s.meta?.move_name ? ` — ${s.meta.move_name}` : '');
      const right = document.createElement('div');
      right.className = 'right';
      right.textContent = fmtTime(s.duration_sec);
      left.appendChild(name);
      item.appendChild(left);
      item.appendChild(right);
      timelineEl.appendChild(item);
    });
  }

  // Station grid
  function getStationKey(stationNum){
    return `${tenantSlug}:${activeSourceId||'src'}:${stationNum}`;
  }
  function getStationMeta(stationNum){
    const key = getStationKey(stationNum);
    return stationMeta[key] || {note:'', equip:[]};
  }
  function setStationMeta(stationNum, payload){
    const key = getStationKey(stationNum);
    stationMeta[key] = payload;
    writeJSON(STATION_META_KEY, stationMeta);
  }

  function renderStationGrid(){
    if(!stationGrid) return;
    stationGrid.innerHTML = '';
    stations.forEach(st=>{
      const card = document.createElement('div');
      card.className = 'station-card';
      const meta = getStationMeta(st.station);
      card.innerHTML = `
        <div class="station-top">
          <div class="station-num">Station ${st.station}</div>
          <div class="station-people">${st.people ? `${st.people} ppl` : ''}</div>
        </div>
        <div class="station-moves">
          <div class="move"><span class="lbl">A</span> <span class="name">${escapeHTML(st.move_a||'—')}</span></div>
          <div class="move"><span class="lbl">B</span> <span class="name">${escapeHTML(st.move_b||'—')}</span></div>
        </div>
        <div class="station-meta">
          ${meta.equip && meta.equip.length ? `<div class="equip">${meta.equip.map(e=>`<span class="chip">${escapeHTML(equipLabelFromId(e.id))}${e.count?` ×${e.count}`:''}</span>`).join('')}</div>` : '<div class="small muted">No equipment set</div>'}
          ${meta.note ? `<div class="note">${escapeHTML(meta.note)}</div>` : ''}
        </div>
        <div class="station-actions"><button class="btn btn-small" data-edit="${st.station}">Edit</button></div>
      `;
      stationGrid.appendChild(card);
    });

    stationGrid.querySelectorAll('[data-edit]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const stationNum = Number(btn.getAttribute('data-edit'));
        openStationModal(stationNum);
      });
    });
  }

  // Station modal
  const stationModal = qs('#stationModal');
  const stationModalTitle = qs('[data-station-modal-title]');
  const stationModalBody = qs('[data-station-modal-body]');
  const stationModalClose = qs('[data-station-modal-close]');

  let editingStation = null;
  let stationDraft = null;

  function openStationModal(stationNum){
    if(!stationModal) return;
    editingStation = stationNum;
    const st = stations.find(x=>x.station===stationNum) || {station:stationNum};
    stationDraft = JSON.parse(JSON.stringify(getStationMeta(stationNum)));

    if(stationModalTitle) stationModalTitle.textContent = `Station ${stationNum}`;
    if(!stationModalBody) return;

    const equipRows = (stationDraft.equip||[]).map((e, idx)=>`
      <div class="equip-row" data-eidx="${idx}">
        <select data-equip-select>${equipOptionsHTML(e.id)}</select>
        <input type="number" min="1" step="1" value="${e.count||1}" data-equip-count>
        <button class="btn btn-small" data-equip-remove>Remove</button>
      </div>
    `).join('');

    stationModalBody.innerHTML = `
      <div class="form-grid">
        <div class="field">
          <label>Notes</label>
          <textarea rows="3" data-note>${escapeHTML(stationDraft.note||'')}</textarea>
        </div>
      </div>
      <div class="field">
        <label>Equipment</label>
        <div data-equip-rows>${equipRows || '<div class="small muted">No equipment rows yet.</div>'}</div>
        <div class="row">
          <button class="btn btn-small" data-equip-add>Add equipment</button>
          <button class="btn btn-small btn-ghost" data-clear>Clear</button>
        </div>
      </div>
      <div class="row">
        <button class="btn" data-save>Save</button>
        <button class="btn btn-ghost" data-cancel>Cancel</button>
      </div>
    `;

    const rowsWrap = qs('[data-equip-rows]', stationModalBody);
    const bindRow = (rowEl)=>{
      const sel = qs('[data-equip-select]', rowEl);
      const cnt = qs('[data-equip-count]', rowEl);
      const rm = qs('[data-equip-remove]', rowEl);
      if(sel) sel.addEventListener('change', ()=> syncDraftFromDOM());
      if(cnt) cnt.addEventListener('input', ()=> syncDraftFromDOM());
      if(rm) rm.addEventListener('click', ()=>{
        rowEl.remove();
        syncDraftFromDOM();
      });
    };

    function syncDraftFromDOM(){
      const note = qs('[data-note]', stationModalBody)?.value || '';
      const rows = Array.from(stationModalBody.querySelectorAll('.equip-row'));
      const equip = [];
      rows.forEach(r=>{
        const id = equipIdFromAny(qs('[data-equip-select]', r)?.value);
        const count = clampInt(qs('[data-equip-count]', r)?.value, 1, 99, 1);
        if(id) equip.push({id, count});
      });
      stationDraft = {note: String(note).trim(), equip};
    }

    stationModalBody.querySelectorAll('.equip-row').forEach(bindRow);

    const addBtn = qs('[data-equip-add]', stationModalBody);
    if(addBtn) addBtn.addEventListener('click', ()=>{
      if(!rowsWrap) return;
      // remove placeholder
      if(rowsWrap.querySelector('.small')) rowsWrap.innerHTML = '';
      const idx = rowsWrap.querySelectorAll('.equip-row').length;
      const row = document.createElement('div');
      row.className = 'equip-row';
      row.setAttribute('data-eidx', String(idx));
      row.innerHTML = `
        <select data-equip-select>${equipOptionsHTML('')}</select>
        <input type="number" min="1" step="1" value="1" data-equip-count>
        <button class="btn btn-small" data-equip-remove>Remove</button>
      `;
      rowsWrap.appendChild(row);
      bindRow(row);
      syncDraftFromDOM();
    });

    const clearBtn = qs('[data-clear]', stationModalBody);
    if(clearBtn) clearBtn.addEventListener('click', ()=>{
      stationDraft = {note:'', equip:[]};
      openStationModal(stationNum); // re-render
    });

    const saveBtn = qs('[data-save]', stationModalBody);
    if(saveBtn) saveBtn.addEventListener('click', ()=>{
      syncDraftFromDOM();
      setStationMeta(editingStation, stationDraft);
      closeStationModal();
      renderStationGrid();
      injectBanner(`Saved Station ${editingStation} settings.`, 'info');
    });

    const cancelBtn = qs('[data-cancel]', stationModalBody);
    if(cancelBtn) cancelBtn.addEventListener('click', closeStationModal);

    stationModal.setAttribute('aria-hidden', 'false');
    stationModal.style.display = 'flex';
  }
  function closeStationModal(){
    if(!stationModal) return;
    stationModal.setAttribute('aria-hidden', 'true');
    stationModal.style.display = 'none';
    editingStation = null;
    stationDraft = null;
  }
  if(stationModalClose) stationModalClose.addEventListener('click', closeStationModal);
  if(stationModal) stationModal.addEventListener('click', (e)=>{ if(e.target===stationModal) closeStationModal(); });

  function populateDemoSelect(){
    if(!demoSel) return;

    const tpls = getBizGymTemplates(tenantSlug).filter(t => t && t.mode === 'gym');
    const mods = getBizGymModsToday(tenantSlug).filter(t => t && t.mode === 'gym');

    demoSel.innerHTML = '';

    const og1 = document.createElement('optgroup');
    og1.label = 'Demos';
    demos.forEach(d=>{
      const opt = document.createElement('option');
      opt.value = `demo:${d.id}`;
      opt.textContent = d.title;
      og1.appendChild(opt);
    });
    demoSel.appendChild(og1);

    const og2 = document.createElement('optgroup');
    og2.label = 'Templates (local)';
    tpls.forEach(t=>{
      const opt = document.createElement('option');
      opt.value = `tpl:${t.id}`;
      opt.textContent = t.title || 'Untitled Template';
      og2.appendChild(opt);
    });
    demoSel.appendChild(og2);

    const og3 = document.createElement('optgroup');
    og3.label = `Today’s Mods (${isoDateLocal()})`;
    mods.forEach(t=>{
      const opt = document.createElement('option');
      opt.value = `mod:${t.id}`;
      opt.textContent = t.title || 'Untitled Mod';
      og3.appendChild(opt);
    });
    demoSel.appendChild(og3);

    demoSel.addEventListener('change', ()=> loadSourceById(demoSel.value));

    const q = new URLSearchParams(location.search);
    const want = q.get('src');
    if(want){
      demoSel.value = want;
    }
  }

  function resolveSource(id){
    const raw = String(id||'').trim();
    if(raw.startsWith('tpl:')){
      const tid = raw.slice(4);
      const t = getBizGymTemplates(tenantSlug).find(x=>String(x.id)===tid);
      if(t) return Object.assign({id:raw}, t);
    }
    if(raw.startsWith('mod:')){
      const tid = raw.slice(4);
      const t = getBizGymModsToday(tenantSlug).find(x=>String(x.id)===tid);
      if(t) return Object.assign({id:raw}, t);
    }
    if(raw.startsWith('demo:')){
      const did = raw.slice(5);
      const d = demos.find(x=>x.id===did);
      if(d) return Object.assign({id:raw}, d);
    }
    const d = demos[0];
    return d ? Object.assign({id:`demo:${d.id}`}, d) : null;
  }

  function loadSourceById(id){
    const src = resolveSource(id);
    if(!src) return;

    activeSourceId = src.id;
    baseSegments = cloneSegments(src.segments || []);
    segments = cloneSegments(baseSegments);

    baseStations = JSON.parse(JSON.stringify(src.stations || []));
    stations = JSON.parse(JSON.stringify(baseStations || []));

    capUndoSnapshot = null;
    if(undoCapBtn) show(undoCapBtn, false);

    if(capMin) capMin.value = String(src.cap_suggestion_min || 42);

    renderStationGrid();
    renderTimeline(0);
    updateTotals('');
    buildEngine();
  }

  function maybeCountdownBeep(idx, segRemaining){
    if(!countdownChk || !countdownChk.checked) return;
    const sec = Math.ceil(segRemaining);
    if(sec >= 1 && sec <= 3){
      if(lastCountdown.idx !== idx || lastCountdown.sec !== sec){
        lastCountdown = {idx, sec};
        beep({freq: 880, duration: 0.06, volume: getBeepVolume()*0.55});
      }
    }
  }

  function buildEngine(){
    if(engine){
      engine.pause();
      engine = null;
    }
    const speed = Number(speedSel?.value || 1) || 1;
    engine = new HiitTimerEngine(segments, {
      timeScale: speed,
      onSegment: ({idx, segment})=>{
        setBadgesForSegment(segment);
        if(nextEl) nextEl.textContent = findNextSummary(idx);
        renderTimeline(idx);

        if(idx>0){
          const k = segment.kind;
          if(k==='WORK') beepPattern('work');
          else if(k==='REST') beepPattern('rest');
          else if(k==='MOVE_TRANSITION_A') beepPattern('move_a');
          else if(k==='MOVE_TRANSITION_B') beepPattern('move_b');
          else if(k==='STATION_STAGE_TRANSITION') beepPattern('station');
        }
      },
      onTick: ({idx, segRemaining})=>{
        if(clockEl) clockEl.textContent = fmtTime(segRemaining);
        maybeCountdownBeep(idx, segRemaining);
      },
      onComplete: ()=>{
        if(clockEl) clockEl.textContent = '00:00';
        if(segKindEl) segKindEl.textContent = 'Complete';
        if(nextEl) nextEl.textContent = '—';
        beepPattern('complete');
        setWakeLockWanted(false);
      }
    });
  }

  // Fullscreen helper
  async function toggleFullscreen(){
    try{
      if(document.fullscreenElement){
        await document.exitFullscreen();
      }else{
        await document.documentElement.requestFullscreen();
      }
    }catch(e){}
    if(fullscreenBtn){
      fullscreenBtn.textContent = document.fullscreenElement ? 'Exit Fullscreen' : 'Fullscreen';
    }
  }

  // Buttons
  if(startBtn){
    startBtn.addEventListener('click', ()=>{
      setVolFromUI();
      unlockAudio();
      if(keepAwakeChk && keepAwakeChk.checked){
        setWakeLockWanted(true);
      }
      beepPattern('start');
      engine?.start();
    });
  }
  if(pauseBtn){
    pauseBtn.addEventListener('click', ()=>{
      if(!engine) return;
      if(engine.isRunning()){
        engine.pause();
        pauseBtn.textContent = 'Resume';
        setWakeLockWanted(false);
      }else{
        setVolFromUI();
        unlockAudio();
        if(keepAwakeChk && keepAwakeChk.checked){
          setWakeLockWanted(true);
        }
        engine.start();
        pauseBtn.textContent = 'Pause';
      }
    });
  }
  if(skipBtn) skipBtn.addEventListener('click', ()=> engine?.skip());
  if(resetBtn){
    resetBtn.addEventListener('click', ()=>{
      engine?.reset();
      pauseBtn && (pauseBtn.textContent = 'Pause');
      setWakeLockWanted(false);
      renderTimeline(0);
      updateTotals('');
      if(segments[0]){
        setBadgesForSegment(segments[0]);
        if(nextEl) nextEl.textContent = findNextSummary(0);
      }
    });
  }

  // Autopause on background
  document.addEventListener('visibilitychange', ()=>{
    if(!autoPauseChk || !autoPauseChk.checked) return;
    if(document.hidden && engine && engine.isRunning()){
      engine.pause();
      if(pauseBtn) pauseBtn.textContent = 'Resume';
      setWakeLockWanted(false);
      injectBanner('Paused because the app went to the background. Tap Resume when you’re ready.', 'warn');
    }
  });

  if(fullscreenBtn) fullscreenBtn.addEventListener('click', toggleFullscreen);

  // Builder link
  if(builderBtn) builderBtn.addEventListener('click', ()=> location.href = '/biz/gym-timer/builder/');



  // Cap-filler UI behavior (member timer)
  function syncCapFillAll(){
    if(!capFillAllChk) return;
    const any = (capFillGroupChks||[]).some(el => el && el.checked);
    capFillAllChk.checked = !any;
  }
  if(capFillAllChk){
    capFillAllChk.addEventListener('change', ()=>{
      if(capFillAllChk.checked){
        (capFillGroupChks||[]).forEach(el => { if(el) el.checked = false; });
      }
      syncCapFillAll();
    });
  }
  (capFillGroupChks||[]).forEach(el=>{
    if(!el) return;
    el.addEventListener('change', ()=> syncCapFillAll());
  });
  syncCapFillAll();

  function readCapFillOpts(){
    const secPer = clampInt(capFillSecIn?.value, 10, 180, 30);
    const groups = (capFillGroupChks||[]).filter(c=>c && c.checked).map(c=>String(c.value||'').trim()).filter(Boolean);
    const useAll = !!capFillAllChk?.checked || groups.length===0;
    return {
      sec_per_move: secPer,
      groups,
      use_all: useAll,
      balance: !!capFillBalanceChk?.checked,
      strict: !!capFillStrictChk?.checked,
      no_repeats: !!capFillNoRepeatChk?.checked
    };
  }

  function buildCapFillerSegments(deltaSec){
    const opts = readCapFillOpts();
    const basePool = Array.isArray(_movesCatalog) ? _movesCatalog.slice() : [];
    if(!basePool.length){
      return [{kind:'WORK', duration_sec: Math.max(1, Math.floor(deltaSec||1)), meta:{move_name:'Cap Filler'}}];
    }

    // Filter by muscle-group selection (derived from move titles)
    let pool = basePool;
    const selected = (opts.groups||[]).map(g=>String(g||'').toLowerCase().trim()).filter(Boolean);
    if(!opts.use_all && selected.length){
      const filtered = basePool.filter(m=>{
        const gs = moveGroupSet(m);
        if(opts.strict) return selected.every(g => gs.has(g));
        return selected.some(g => gs.has(g));
      });
      pool = filtered.length ? filtered : basePool;
    }

    const per = clampInt(opts.sec_per_move, 10, 180, 30);
    let remaining = Math.max(1, Math.floor(Number(deltaSec||1)));

    // Optional round-robin by selected groups
    let groupPools = null;
    if(opts.balance && !opts.strict && !opts.use_all && selected.length>1){
      groupPools = {};
      selected.forEach(g=>{
        groupPools[g] = pool.filter(m=> moveGroupSet(m).has(g));
      });
    }

    const used = new Set();
    const out = [];
    let i = 0;

    while(remaining > 0){
      const dur = Math.min(per, remaining);
      let pickFrom = pool;

      if(groupPools){
        const g = selected[i % selected.length];
        const gp = groupPools[g] || [];
        if(gp.length) pickFrom = gp;
      }

      let chosen = null;
      for(let tries=0; tries<60; tries++){
        const cand = pickFrom[Math.floor(Math.random()*pickFrom.length)];
        const id = String(cand?.video_id || '');
        if(!id) continue;
        if(opts.no_repeats && used.has(id) && pickFrom.length>1) continue;
        chosen = cand;
        break;
      }
      if(!chosen) chosen = pickFrom[Math.floor(Math.random()*pickFrom.length)];

      const vid = String(chosen?.video_id || '');
      if(vid) used.add(vid);

      out.push({
        kind:'WORK',
        duration_sec: dur,
        meta:{
          mode:'online',
          move_name: String(chosen?.title || 'Cap Filler'),
          video_embed_url: String(chosen?.embed_url || ''),
          rest_type: 'Cap Filler',
          is_cap_filler: true
        }
      });

      remaining -= dur;
      i++;
    }

    return out;
  }

  // Volume wire-up
  syncVolUI();
  if(volRange) volRange.addEventListener('input', setVolFromUI);
  if(testBeepBtn){
    testBeepBtn.addEventListener('click', ()=>{
      setVolFromUI();
      ensureAudio();
      beepPattern('work');
    });
  }

  // Apply cap / undo cap
  if(applyCapBtn){
    applyCapBtn.addEventListener('click', ()=>{
      const minutes = clampInt(capMin?.value, 1, 300, 42);
      const cap = minutes*60;
      const pool = String(capPool?.value || 'all');
      const under_strategy = String(capUnder?.value || 'adjust');

      capUndoSnapshot = {segments: cloneSegments(segments), stations: JSON.parse(JSON.stringify(stations)), note:'', cap, pool, under_strategy, ts: Date.now()};
      const finisher_builder = (under_strategy==='finisher') ? (delta)=> buildCapFillerSegments(delta) : null;
      const res = applyTimeCap(baseSegments, cap, pool, {under_strategy, finisher_name:'Cap Filler', finisher_builder});
      segments = cloneSegments(res.segments);
      updateTotals(res.note);
      renderTimeline(0);
      buildEngine();
      if(undoCapBtn) show(undoCapBtn, true);
      injectBanner(res.note, 'info');
    });
  }
  if(undoCapBtn){
    undoCapBtn.addEventListener('click', ()=>{
      if(!capUndoSnapshot) return;
      segments = cloneSegments(capUndoSnapshot.segments);
      stations = JSON.parse(JSON.stringify(capUndoSnapshot.stations || []));
      capUndoSnapshot = null;
      updateTotals('Cap undone.');
      renderTimeline(0);
      renderStationGrid();
      buildEngine();
      show(undoCapBtn, false);
      injectBanner('Time cap undone.', 'info');
    });
  }

  populateDemoSelect();

  // Initial load
  if(demoSel && demoSel.value){
    loadSourceById(demoSel.value);
  }else{
    const first = demos[0];
    if(first) loadSourceById(`demo:${first.id}`);
  }
}



function pageAdmin(){
  const role = getRole();
  const roleOut = qs('[data-admin-role]');
  if(roleOut) roleOut.textContent = roleLabel(role);

  const tenantOut = qs('[data-admin-tenant]');
  const t = getTenant();
  const tName = getTenantName();
  if(tenantOut) tenantOut.textContent = t ? (tName || t) : 'None';

  const clearBtn = qs('[data-admin-clear-tenant]');
  if(clearBtn){
    clearBtn.addEventListener('click', async ()=>{
      setTenant({slug:'', name:''});
      applyNavRole();
  await loadBuildInfo();
  applyBuildLabel();
      if(tenantOut) tenantOut.textContent = 'None';
    });
  }
}

function getNextFromURL(){
  const u = new URL(location.href);
  return u.searchParams.get('next') || '';
}

async function pageLogin(){
  const next = getNextFromURL();
  // Stripe return handler (success/cancel)
  try{
    const params = new URLSearchParams(location.search || '');
    const checkout = params.get('checkout');
    if(checkout){
      const tier = params.get('tier') || 'member';
      const plan = params.get('plan') || 'monthly';
      const biz_tier = params.get('biz_tier') || 'pro';
      const locations = params.get('locations') || '1';
      const tenant = params.get('tenant') || '';
      const session_id = params.get('session_id') || '';

      if(checkout === 'success'){
        if(tier === 'business'){
          if(tenant){
            // ensure tenant exists in demo list so selector can find it
            upsertCustomTenant({slug: tenant, name: tenant});
            setTenant({slug: tenant, name: tenant});
            localStorage.setItem('hiit56_biz_plan_demo_' + tenant, plan);
            localStorage.setItem('hiit56_biz_tier_demo_' + tenant, biz_tier);
            localStorage.setItem('hiit56_biz_locations_demo_' + tenant, locations);
            if(isStripeCheckoutSessionId(session_id)) setBizCheckoutSessionId(tenant, session_id);
          }
          setRole('biz_admin');
          injectBanner(`<strong>Checkout complete.</strong> Business <span class="badge">${biz_tier}</span> plan set to <span class="badge">${plan}</span> (<span class="badge">${locations} location(s)</span>) — demo entitlements until Supabase sync.`);
        }else{
          setTenant({slug:'', name:''});
          setRole('member');
          localStorage.setItem('hiit56_member_plan_demo', plan);
          if(isStripeCheckoutSessionId(session_id)) setMemberCheckoutSessionId(session_id);
          injectBanner(`<strong>Checkout complete.</strong> Member plan set to <span class="badge">${plan}</span> (demo entitlements until Supabase sync).`);
        }
      }else if(checkout === 'cancelled'){
        injectBanner('<strong>Checkout cancelled.</strong> You can try again any time.');
      }

      // Clean URL (preserve next)
      const nextOnly = params.get('next');
      const clean = nextOnly ? (`/login.html?next=${encodeURIComponent(nextOnly)}`) : '/login.html';
      history.replaceState({}, '', clean);
    }
  }catch(e){ /* ignore */ }


  const tenantSel = qs('[data-tenant-select]');
  const emailInput = qs('[data-demo-email]');
  const tenantNote = qs('[data-tenant-note]');

  // Load demo tenants (until Supabase multi-tenant is wired)
  let tenants = [];
  try{
    const loaded = await loadJSON('/assets/data/tenants_demo.json');
    if(Array.isArray(loaded)) tenants = loaded;
  }catch(e){ tenants = []; }

  // Merge custom tenants created in /admin/tenants (demo-localStorage)
  const custom = getCustomTenants();
  const seen = new Set(tenants.map(t=>t.slug));
  custom.forEach(t=>{ if(t && t.slug && !seen.has(t.slug)){ tenants.push({slug:t.slug, name:t.name || t.slug, custom:true}); seen.add(t.slug);} });

  if(emailInput){
    emailInput.value = getEmail();
    emailInput.addEventListener('change', ()=> setEmail(emailInput.value));
  }

  if(tenantSel){
    tenantSel.innerHTML = '';
    const opt0 = document.createElement('option');
    opt0.value = '';
    opt0.textContent = 'Select a business (demo)...';
    tenantSel.appendChild(opt0);

    tenants.forEach(t=>{
      const opt = document.createElement('option');
      opt.value = t.slug;
      opt.textContent = t.name;
      tenantSel.appendChild(opt);
    });

    const cur = getTenant();
    if(cur) tenantSel.value = cur;
  }

  function chosenTenant(){
    if(!tenantSel) return {slug:'', name:''};
    const slug = tenantSel.value || '';
    const name = tenantSel.options[tenantSel.selectedIndex]?.textContent || slug;
    return {slug, name};
  }

  function go(role){
    setRole(role);
    if(emailInput) setEmail(emailInput.value);

    if(isBizRole(role)){
      const t = chosenTenant();
      if(!t.slug){
        if(tenantNote) tenantNote.textContent = 'Select a business to continue.';
        return;
      }
      setTenant(t);
    }else if(role === 'super_admin'){
      // Super admin can optionally pick a tenant to view its context
      const t = chosenTenant();
      if(t.slug) setTenant(t); else setTenant({slug:'', name:''});
    }else{
      setTenant({slug:'', name:''});
    }

    const dest = next || (
      role === 'member' ? '/app/' :
      (isBizRole(role) ? '/biz/' :
      (role === 'super_admin' ? '/admin/' : '/'))
    );
    location.href = dest;
  }

  const guestBtn = qs('[data-login-guest]');
  const memberBtn = qs('[data-login-member]');
  const staffBtn = qs('[data-login-biz-staff]');
  const adminBtn = qs('[data-login-biz-admin]');
  const superBtn = qs('[data-login-super-admin]');

  if(guestBtn) guestBtn.addEventListener('click', ()=>go('guest'));
  if(memberBtn) memberBtn.addEventListener('click', ()=>go('member'));
  if(staffBtn) staffBtn.addEventListener('click', ()=>go('biz_staff'));
  if(adminBtn) adminBtn.addEventListener('click', ()=>go('biz_admin'));
  if(superBtn) superBtn.addEventListener('click', ()=>go('super_admin'));
}

function guardPage(page){
  const role = getRole();
  const next = encodeURIComponent(location.pathname + location.search);

  if(page && page.startsWith('biz-')){
    if(!canAccessBiz()){
      location.href = `/login.html?next=${next}`;
      return false;
    }
    if(isBizRole(role) && !getTenant()){
      location.href = `/login.html?next=${next}`;
      return false;
    }
  }

  if(page && page.startsWith('admin-')){
    if(!isSuperAdmin(role)){
      location.href = `/login.html?next=${next}`;
      return false;
    }
  }

  if(page && page.startsWith('member-')){
    if(!canAccessMember()){
      location.href = `/login.html?next=${next}`;
      return false;
    }
  }

  return true;
}



// =========================
// CP10 pages (demo billing scaffolding)
// =========================

function wireSignOut(btn){
  if(!btn) return;
  btn.addEventListener('click', async ()=>{
    setRole('guest');
    setTenant({slug:'', name:''});
    applyNavRole();
  await loadBuildInfo();
  applyBuildLabel();
    location.href = '/';
  });
}

function describeComp(rec){
  if(!rec) return 'No active comp.';
  if(rec.expires_at === null) return 'Comp active (forever).';
  const d = parseISO(rec.expires_at);
  return d ? `Comp active until ${d.toLocaleDateString()}.` : 'Comp active.';
}

function pageMemberAccount(){
  const email = getEmail();
  const emailOut = qs('[data-account-email]');
  if(emailOut) emailOut.textContent = email || '(not set)';

  const roleOut = qs('[data-account-role]');
  if(roleOut) roleOut.textContent = roleLabel(getRole());

  const couponCur = qs('[data-coupon-current]');
  const couponNote = qs('[data-coupon-note]');
  const input = qs('[data-coupon-input]');
  const applyBtn = qs('[data-coupon-apply]');
  const clearBtn = qs('[data-coupon-clear]');

  const cur = getAppliedCoupon('member');
  if(couponCur) couponCur.textContent = cur ? cur : 'None';

  function syncNote(){
    const code = getAppliedCoupon('member');
    const defs = getCouponDefs('member');
    const def = defs.find(c => normCode(c.code) === code);
    if(couponNote){
      couponNote.textContent = def ? (def.note || 'Coupon applied.') : (code ? 'Coupon applied.' : '');
    }
  }
  syncNote();

  if(applyBtn){
    applyBtn.addEventListener('click', ()=>{
      const c = normCode(input?.value || '');
      if(!c){ if(couponNote) couponNote.textContent = 'Enter a code.'; return; }
      setAppliedCoupon('member', c);
      if(couponCur) couponCur.textContent = c;
      syncNote();
    });
  }
  if(clearBtn){
    clearBtn.addEventListener('click', ()=>{
      setAppliedCoupon('member', '');
      if(couponCur) couponCur.textContent = 'None';
      if(input) input.value = '';
      if(couponNote) couponNote.textContent = '';
    });
  }

  const compOut = qs('[data-comp-status]');
  if(compOut) compOut.textContent = describeComp(getActiveMemberComp(email));

  // Billing portal (CP18)
  const billStatus = qs('[data-billing-status]');
  const billManage = qs('[data-billing-manage]');
  const billClear = qs('[data-billing-clear]');

  function syncBilling(){
    const sid = getMemberCheckoutSessionId();
    if(billStatus){
      billStatus.textContent = sid ? `Linked (session ${sid})` : 'Not linked yet. Complete checkout once to enable billing portal.';
    }
    if(billManage) billManage.disabled = !sid;
    if(billClear) billClear.disabled = !sid;
  }
  syncBilling();

  if(billManage){
    billManage.addEventListener('click', async ()=>{
      try{
        billManage.disabled = true;
        const old = billManage.textContent;
        billManage.textContent = 'Opening…';
        await openBillingPortal({scope:'member'});
        billManage.textContent = old;
      }catch(err){
        console.warn('Billing portal error:', err);
        billManage.disabled = false;
        billManage.textContent = 'Manage Billing';
        injectBanner('<strong>Billing portal unavailable.</strong> This works on deployed Netlify builds (Functions), not local static QA preview.');
      }
    });
  }
  if(billClear){
    billClear.addEventListener('click', ()=>{
      clearMemberCheckoutSessionId();
      syncBilling();
    });
  }

  wireSignOut(qs('[data-account-signout]'));
}

function pageBizAccount(){
  const email = getEmail();
  const emailOut = qs('[data-account-email]');
  if(emailOut) emailOut.textContent = email || '(not set)';

  const roleOut = qs('[data-account-role]');
  if(roleOut) roleOut.textContent = roleLabel(getRole());

  const tenantOut = qs('[data-account-tenant]');
  if(tenantOut) tenantOut.textContent = getTenantName() || getTenant() || '(none)';

  const couponCur = qs('[data-coupon-current]');
  const couponNote = qs('[data-coupon-note]');
  const input = qs('[data-coupon-input]');
  const applyBtn = qs('[data-coupon-apply]');
  const clearBtn = qs('[data-coupon-clear]');

  const cur = getAppliedCoupon('biz', getTenant());
  if(couponCur) couponCur.textContent = cur ? cur : 'None';

  function syncNote(){
    const code = getAppliedCoupon('biz', getTenant());
    const defs = getCouponDefs('biz');
    const def = defs.find(c => normCode(c.code) === code);
    if(couponNote){
      couponNote.textContent = def ? (def.note || 'Coupon applied.') : (code ? 'Coupon applied.' : '');
    }
  }
  syncNote();

  if(applyBtn){
    applyBtn.addEventListener('click', ()=>{
      const c = normCode(input?.value || '');
      if(!c){ if(couponNote) couponNote.textContent = 'Enter a code.'; return; }
      setAppliedCoupon('biz', c, getTenant());
      if(couponCur) couponCur.textContent = c;
      syncNote();
    });
  }
  if(clearBtn){
    clearBtn.addEventListener('click', ()=>{
      setAppliedCoupon('biz', '', getTenant());
      if(couponCur) couponCur.textContent = 'None';
      if(input) input.value = '';
      if(couponNote) couponNote.textContent = '';
    });
  }

  const compOut = qs('[data-comp-status]');
  if(compOut) compOut.textContent = describeComp(getActiveBizComp(getTenant()));

  // Billing portal (CP18)
  const billStatus = qs('[data-billing-status]');
  const billManage = qs('[data-billing-manage]');
  const billClear = qs('[data-billing-clear]');
  const tenant = getTenant();

  function syncBilling(){
    const sid = getBizCheckoutSessionId(tenant);
    if(billStatus){
      billStatus.textContent = sid ? `Linked (session ${sid})` : 'Not linked yet. Complete checkout once to enable billing portal.';
    }
    if(billManage) billManage.disabled = !sid;
    if(billClear) billClear.disabled = !sid;
  }
  syncBilling();

  if(billManage){
    billManage.addEventListener('click', async ()=>{
      try{
        billManage.disabled = true;
        const old = billManage.textContent;
        billManage.textContent = 'Opening…';
        await openBillingPortal({scope:'biz'});
        billManage.textContent = old;
      }catch(err){
        console.warn('Billing portal error:', err);
        billManage.disabled = false;
        billManage.textContent = 'Manage Billing';
        injectBanner('<strong>Billing portal unavailable.</strong> This works on deployed Netlify builds (Functions), not local static QA preview.');
      }
    });
  }
  if(billClear){
    billClear.addEventListener('click', ()=>{
      clearBizCheckoutSessionId(tenant);
      syncBilling();
    });
  }

  wireSignOut(qs('[data-account-signout]'));
}

function pageBizOnboarding(){
  const tOut = qs('[data-onboard-tenant]');
  if(tOut) tOut.textContent = getTenantName() || getTenant() || '(none)';
  const roleOut = qs('[data-onboard-role]');
  if(roleOut) roleOut.textContent = roleLabel(getRole());
}

function pageAdminTenants(){
  const formSlug = qs('[data-tenant-slug]');
  const formName = qs('[data-tenant-name]');
  const addBtn = qs('[data-tenant-add]');
  const list = qs('[data-tenant-list]');

  async function getBaseTenants(){
    try{
      const loaded = await loadJSON('/assets/data/tenants_demo.json');
      return Array.isArray(loaded) ? loaded : [];
    }catch(e){ return []; }
  }

  function paintRow(t, {custom=false}={}){
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="mono">${t.slug}</td>
      <td>${t.name || t.slug}</td>
      <td>${custom ? 'Custom' : 'Base'}</td>
      <td>
        <div class="btn-row">
          <button class="btn" data-imp-staff>Staff</button>
          <button class="btn" data-imp-admin>Admin</button>
          ${custom ? '<button class="btn" data-del>Delete</button>' : ''}
        </div>
      </td>
    `;
    qs('[data-imp-staff]', tr)?.addEventListener('click', async ()=>{
      setRole('biz_staff');
      setTenant({slug:t.slug, name:t.name || t.slug});
      applyNavRole();
  await loadBuildInfo();
  applyBuildLabel();
      location.href = '/biz/';
    });
    qs('[data-imp-admin]', tr)?.addEventListener('click', async ()=>{
      setRole('biz_admin');
      setTenant({slug:t.slug, name:t.name || t.slug});
      applyNavRole();
  await loadBuildInfo();
  applyBuildLabel();
      location.href = '/biz/';
    });
    qs('[data-del]', tr)?.addEventListener('click', ()=>{
      removeCustomTenant(t.slug);
      refresh();
    });
    return tr;
  }

  async function refresh(){
    if(!list) return;
    list.innerHTML = '';
    const base = await getBaseTenants();
    const custom = getCustomTenants();
    base.forEach(t => list.appendChild(paintRow(t, {custom:false})));
    custom.forEach(t => list.appendChild(paintRow(t, {custom:true})));
  }

  if(addBtn){
    addBtn.addEventListener('click', ()=>{
      const slug = String(formSlug?.value || '').trim();
      const name = String(formName?.value || '').trim();
      if(!slug) return alert('Slug required.');
      upsertCustomTenant({slug, name});
      if(formSlug) formSlug.value = '';
      if(formName) formName.value = '';
      refresh();
    });
  }

  refresh();
}

function pageAdminCoupons(){
  const code = qs('[data-coupon-code]');
  const scope = qs('[data-coupon-scope]');
  const note = qs('[data-coupon-note]');
  const pct  = qs('[data-coupon-pct]');
  const amt  = qs('[data-coupon-amt]');
  const addBtn = qs('[data-coupon-add]');

  const memberList = qs('[data-coupon-list-member]');
  const bizList = qs('[data-coupon-list-biz]');

  function paint(scopeKey, root){
    if(!root) return;
    root.innerHTML = '';
    const defs = getCouponDefs(scopeKey);
    defs.forEach(c=>{
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="mono">${normCode(c.code)}</td>
        <td>${c.note || ''}</td>
        <td>${c.percent_off ? (c.percent_off + '%') : ''}</td>
        <td>${c.amount_off ? ('$' + c.amount_off) : ''}</td>
        <td><button class="btn" data-del>Delete</button></td>
      `;
      qs('[data-del]', tr)?.addEventListener('click', ()=>{
        deleteCoupon(scopeKey, c.code);
        refresh();
      });
      root.appendChild(tr);
    });
  }

  function refresh(){
    paint('member', memberList);
    paint('biz', bizList);
  }

  if(addBtn){
    addBtn.addEventListener('click', ()=>{
      const sc = (scope?.value === 'biz') ? 'biz' : 'member';
      const c = normCode(code?.value || '');
      if(!c) return alert('Coupon code required.');
      upsertCoupon(sc, {
        code: c,
        note: String(note?.value||'').trim(),
        percent_off: Number(pct?.value||0)||0,
        amount_off: Number(amt?.value||0)||0
      });
      if(code) code.value = '';
      if(note) note.value = '';
      if(pct) pct.value = '';
      if(amt) amt.value = '';
      refresh();
    });
  }

  refresh();
}

function pageAdminComps(){
  const memEmail = qs('[data-comp-member-email]');
  const memDays = qs('[data-comp-member-days]');
  const memForever = qs('[data-comp-member-forever]');
  const memNote = qs('[data-comp-member-note]');
  const memAdd = qs('[data-comp-member-add]');
  const memList = qs('[data-comp-member-list]');

  const bizTenant = qs('[data-comp-biz-tenant]');
  const bizDays = qs('[data-comp-biz-days]');
  const bizForever = qs('[data-comp-biz-forever]');
  const bizNote = qs('[data-comp-biz-note]');
  const bizAdd = qs('[data-comp-biz-add]');
  const bizList = qs('[data-comp-biz-list]');

  async function loadTenantsForSelect(){
    const base = await loadJSON('/assets/data/tenants_demo.json').catch(()=>[]);
    const custom = getCustomTenants();
    const all = [...(Array.isArray(base)?base:[]), ...custom];
    if(bizTenant){
      bizTenant.innerHTML = '';
      all.forEach(t=>{
        const opt = document.createElement('option');
        opt.value = t.slug;
        opt.textContent = t.name || t.slug;
        bizTenant.appendChild(opt);
      });
    }
  }

  function paintMember(){
    if(!memList) return;
    memList.innerHTML = '';
    getMemberComps().forEach(c=>{
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="mono">${c.email}</td>
        <td>${c.expires_at === null ? 'Forever' : (parseISO(c.expires_at)?.toLocaleDateString() || '')}</td>
        <td>${c.note || ''}</td>
        <td><button class="btn" data-del>Revoke</button></td>
      `;
      qs('[data-del]', tr)?.addEventListener('click', ()=>{
        revokeMemberComp(c.email);
        paintMember();
      });
      memList.appendChild(tr);
    });
  }

  function paintBiz(){
    if(!bizList) return;
    bizList.innerHTML = '';
    getBizComps().forEach(c=>{
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="mono">${c.tenant_slug}</td>
        <td>${c.expires_at === null ? 'Forever' : (parseISO(c.expires_at)?.toLocaleDateString() || '')}</td>
        <td>${c.note || ''}</td>
        <td><button class="btn" data-del>Revoke</button></td>
      `;
      qs('[data-del]', tr)?.addEventListener('click', ()=>{
        revokeBizComp(c.tenant_slug);
        paintBiz();
      });
      bizList.appendChild(tr);
    });
  }

  if(memAdd){
    memAdd.addEventListener('click', ()=>{
      const email = String(memEmail?.value||'').trim();
      if(!email) return alert('Email required.');
      const days = Number(memDays?.value||30)||30;
      const forever = !!memForever?.checked;
      grantMemberComp(email, {days, forever, note:String(memNote?.value||'').trim()});
      if(memEmail) memEmail.value = '';
      if(memNote) memNote.value = '';
      paintMember();
    });
  }

  if(bizAdd){
    bizAdd.addEventListener('click', ()=>{
      const slug = String(bizTenant?.value||'').trim();
      if(!slug) return alert('Tenant required.');
      const days = Number(bizDays?.value||30)||30;
      const forever = !!bizForever?.checked;
      grantBizComp(slug, {days, forever, note:String(bizNote?.value||'').trim()});
      if(bizNote) bizNote.value = '';
      paintBiz();
    });
  }

  loadTenantsForSelect().then(()=>{
    paintMember();
    paintBiz();
  });
}


function pageAdminStatus(){
  const out = qs('[data-health-output]');
  const stripeOut = qs('[data-stripe-output]');
  const btn = qs('[data-health-refresh]');

  async function refresh(){
    if(out) out.textContent = 'Loading…';
    try{
      const r = await fetch('/api/health', {cache:'no-store'});
      if(!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if(out) out.textContent = JSON.stringify(j, null, 2);
    }catch(err){
      if(out){
        out.textContent =
          'Could not reach /api/health.\n\n' +
          'Expected in local QA preview (no Netlify Functions).\n' +
          'Deploy on Netlify (Git/CLI) with Functions enabled to test Stripe endpoints.\n\n' +
          'Error: ' + (err && err.message ? err.message : String(err));
      }
    }

    if(stripeOut) stripeOut.textContent = 'Loading…';
    try{
      const cfg = await loadJSON('/assets/data/stripe_public_test.json');
      if(stripeOut) stripeOut.textContent = JSON.stringify(cfg, null, 2);
    }catch(err){
      if(stripeOut) stripeOut.textContent = 'Could not load /assets/data/stripe_public_test.json';
    }
  }

  if(btn) btn.addEventListener('click', refresh);
  refresh();
}

function pageJoin(){
  const email = qs('[data-join-email]');
  const plan = qs('[data-join-plan]');
  const coupon = qs('[data-join-coupon]');
  const btn = qs('[data-join-submit]');
  if(email) email.value = getEmail();

  if(btn){
    btn.addEventListener('click', async ()=>{
      const e = String(email?.value||'').trim();
      if(!e) return alert('Email required.');
      setEmail(e);

      const chosenPlan = String(plan?.value||'monthly');
      if(coupon && coupon.value) setAppliedCoupon('member', coupon.value);

      // Try Stripe on deployed Netlify (Functions). Local preview uses demo fallback.
      if(!isLocalPreview()){
        try{
          btn.disabled = true;
          btn.textContent = 'Redirecting…';
          await startStripeCheckout({tier:'member', plan: chosenPlan, email: e});
          return; // redirected
        }catch(err){
          console.warn('Stripe checkout unavailable, falling back to demo:', err);
          btn.disabled = false;
          btn.textContent = 'Continue';
          injectBanner('<strong>Stripe checkout unavailable in this preview.</strong> Using demo access so you can keep QA testing.');
        }
      }

      // Demo fallback (until Supabase entitlement sync is wired)
      setRole('member');
      setTenant({slug:'', name:''});
      localStorage.setItem('hiit56_member_plan_demo', chosenPlan);
      location.href = '/app/';
    });
  }
}

function slugify(s){
  return String(s||'')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g,'-')
    .replace(/(^-|-$)/g,'')
    .slice(0,60);
}

function pageBizStart(){
  const name = qs('[data-biz-name]');
  const email = qs('[data-biz-email]');
  const bizTier = qs('[data-biz-tier]');
  const plan = qs('[data-biz-plan]');
  const locations = qs('[data-biz-locations]');
  const coupon = qs('[data-biz-coupon]');
  const btn = qs('[data-biz-submit]');

  // Prefill from URL (e.g., from pricing cards)
  try{
    const p = new URLSearchParams(location.search || '');
    const t = p.get('tier');
    const pl = p.get('plan');
    const loc = p.get('locations');
    if(bizTier && t) bizTier.value = t;
    if(plan && pl) plan.value = pl;
    if(locations && loc) locations.value = loc;
  }catch(e){}

  if(email) email.value = getEmail();

  if(btn){
    btn.addEventListener('click', async ()=>{
      const n = String(name?.value||'').trim();
      if(!n) return alert('Business name required.');
      const s = slugify(n);
      if(!s) return alert('Could not create a slug from that name.');

      const chosenTier = String(bizTier?.value||'pro');
      const chosenPlan = String(plan?.value||'monthly');
      const e = String(email?.value||'').trim();
      const locQty = clampInt(locations?.value, 1, 50, 1);

      // Create demo tenant locally so QA can proceed (Supabase provisioning comes next)
      upsertCustomTenant({slug:s, name:n});
      setTenant({slug:s, name:n});
      if(e) setEmail(e);

      if(coupon && coupon.value) setAppliedCoupon('biz', coupon.value, s);
      localStorage.setItem('hiit56_biz_plan_demo_' + s, chosenPlan);
      localStorage.setItem('hiit56_biz_tier_demo_' + s, chosenTier);
      localStorage.setItem('hiit56_biz_locations_demo_' + s, String(locQty));

      // Try Stripe on deployed Netlify (Functions). Local preview uses demo fallback.
      if(!isLocalPreview()){
        try{
          btn.disabled = true;
          btn.textContent = 'Redirecting…';
          await startStripeCheckout({tier:'business', plan: chosenPlan, biz_tier: chosenTier, locations: locQty, email: e, tenant_slug: s, tenant_name: n});
          return; // redirected
        }catch(err){
          console.warn('Stripe checkout unavailable, falling back to demo:', err);
          btn.disabled = false;
          btn.textContent = 'Create business portal';
          injectBanner('<strong>Stripe checkout unavailable in this preview.</strong> Using demo tenant so you can keep QA testing.');
        }
      }

      // Demo fallback login
      setRole('biz_admin');
      location.href = '/biz/onboarding/';
    });
  }
}


// =========================
// Build label injection (CP23+)
// =========================
// HIIT56_BUILD_LABEL is defined in the Build info block above.
function applyBuildLabel(){
  const label = (HIIT56_BUILD && HIIT56_BUILD.label) ? HIIT56_BUILD.label : HIIT56_BUILD_LABEL;
  try{
    document.querySelectorAll('.footer').forEach(f=>{
      f.innerHTML = f.innerHTML.replace(/build preview \(CP\d+\)/g, `build preview (${label})`);
    });
    document.querySelectorAll('[data-build-label]').forEach(el=>{
      el.textContent = label;
    });
  }catch(e){}
}


// =========================
// Telemetry (CP26) — lightweight "Sentry-style" crash reporting
// - Sends unhandled errors + key runtime warnings to a Netlify Function.
// - Optional: forward to Slack/Discord webhook via TELEMETRY_WEBHOOK_URL on Netlify.
// =========================
const HIIT56_TELEMETRY_ENDPOINT = '/.netlify/functions/telemetry_ingest';
const HIIT56_SESSION_KEY = 'hiit56_session_id';

function hiit56SessionId(){
  try{
    let sid = sessionStorage.getItem(HIIT56_SESSION_KEY);
    if(!sid){
      sid = Math.random().toString(16).slice(2) + Date.now().toString(16);
      sessionStorage.setItem(HIIT56_SESSION_KEY, sid);
    }
    return sid;
  }catch(e){ return 'unknown'; }
}

function hiit56NormalizeErr(err){
  try{
    if(err instanceof Error) return { name: err.name, message: err.message, stack: err.stack };
    if(typeof err === 'string') return { message: err };
    if(err && typeof err === 'object'){
      // common event shapes
      const msg = err.message || err.reason || err.error || err.toString?.();
      const st = err.stack || err.error?.stack || undefined;
      return { message: String(msg||'Unknown error'), stack: st };
    }
    return { message: String(err) };
  }catch(e){ return { message: 'Unknown error' }; }
}

function hiit56TelemetrySend(eventType, payload) {
  try {
    const body = {
      eventType,
      payload,
      href: location.href,
      ts: new Date().toISOString(),
      build_id: (HIIT56_BUILD && HIIT56_BUILD.build_id) ? HIIT56_BUILD.build_id : HIIT56_BUILD_ID,
      label: (HIIT56_BUILD && HIIT56_BUILD.label) ? HIIT56_BUILD.label : HIIT56_BUILD_LABEL,
      session_id: hiit56SessionId(),
      ua: navigator.userAgent
    };

    const data = JSON.stringify(body);
    if (navigator.sendBeacon) {
      const blob = new Blob([data], { type: 'application/json' });
      navigator.sendBeacon(HIIT56_TELEMETRY_ENDPOINT, blob);
    } else {
      fetch(HIIT56_TELEMETRY_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: data,
        keepalive: true
      }).catch(()=>{});
    }
  } catch (e) { /* ignore */ }
}

function v56ReportError(err){
  try{
    console.error('[HIIT56] Unhandled error:', err);
    hiit56TelemetrySend('frontend_error', hiit56NormalizeErr(err));
    let b = document.querySelector('[data-error-banner]');
    if(!b){
      b = document.createElement('div');
      b.setAttribute('data-error-banner','');
      b.style.position='fixed';
      b.style.left='12px';
      b.style.right='12px';
      b.style.bottom='12px';
      b.style.zIndex='9999';
      b.style.padding='12px 14px';
      b.style.borderRadius='14px';
      b.style.background='rgba(0,0,0,.78)';
      b.style.color='#fff';
      b.style.backdropFilter='blur(8px)';
      b.style.fontSize='14px';
      b.innerHTML = '<strong>Something hiccuped.</strong> <span style="opacity:.8">Try refreshing.</span> <button style="margin-left:10px" class="btn">Refresh</button>';
      document.body.appendChild(b);
      const btn = b.querySelector('button');
      if(btn) btn.addEventListener('click', ()=>location.reload());
      setTimeout(()=>{ try{ b.remove(); }catch(e){} }, 9000);
    }
  }catch(e){}
}

window.addEventListener('error', (e)=> v56ReportError(e?.error || e?.message || e));
window.addEventListener('unhandledrejection', (e)=> v56ReportError(e?.reason || e));

async function init(){

  applyNavRole();
  await loadBuildInfo();
  applyBuildLabel();
  wireModal();
  injectBackBar();
  injectVimeoPreconnect();
  ensureStripePreconnect();

  // Preload thumbnail overrides (safe even if file is empty/missing)
  await loadThumbOverrides();

  const page = document.body.getAttribute('data-page') || '';
  if(!guardPage(page)) return;
  if(page === 'public-workouts') pagePublicWorkouts();
  if(page === 'member-workouts') pageMemberWorkouts();
  if(page === 'public-category') pageCategory({mode:'public'});
  if(page === 'member-category') pageCategory({mode:'member'});
  if(page === 'public-workout-detail') pageWorkoutDetail({mode:'public'});
  if(page === 'member-workout-detail') pageWorkoutDetail({mode:'member'});
  if(page === 'biz-moves') pageBizMoves();
  if(page === 'biz-move-detail') pageBizMoveDetail();
  if(page === 'member-timer') pageMemberTimer();
  if(page === 'member-timer-builder') pageMemberTimerBuilder();
  if(page === 'member-my-workouts') pageMemberMyWorkouts();
  if(page === 'biz-gym-timer') pageBizGymTimer();
  if(page === 'biz-gym-timer-builder') pageBizGymTimerBuilder();
  if(page === 'admin-home') pageAdmin();
  if(page === 'admin-tenants') pageAdminTenants();
  if(page === 'admin-coupons') pageAdminCoupons();
  if(page === 'admin-comps') pageAdminComps();
  if(page === 'admin-status') pageAdminStatus();
  if(page === 'member-account') pageMemberAccount();
  if(page === 'biz-account') pageBizAccount();
  if(page === 'biz-onboarding') pageBizOnboarding();
  if(page === 'public-join') pageJoin();
  if(page === 'public-biz-start') pageBizStart();
  if(page === 'login') pageLogin();
}

document.addEventListener('DOMContentLoaded', ()=>{ init().catch(v56ReportError); });
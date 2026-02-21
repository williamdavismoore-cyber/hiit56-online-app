// netlify/functions/stripe_create_checkout_session.js
// Creates a Stripe Checkout Session (subscription mode) for member + business plans.
// Returns { url } for client-side redirect.

'use strict';

const Stripe = require('stripe');
const fs = require('fs');
const path = require('path');

let _stripePublicCfg = null;

function corsHeaders(event){
  const origin = event?.headers?.origin || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
    'Content-Type': 'application/json'
  };
}

function getOrigin(event){
  const headers = event?.headers || {};
  const host = headers['x-forwarded-host'] || headers.host;
  const proto = headers['x-forwarded-proto'] || 'https';
  if(!host) return 'https://hiit56online.com';
  return `${proto}://${host}`;
}

function safeJsonParse(str){
  try{ return JSON.parse(str || '{}'); }catch{ return null; }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isUuid(v){ return UUID_RE.test(String(v||'')); }

function normalizePlan(p){
  const v = String(p || '').toLowerCase();
  if(v === 'annual' || v === 'year' || v === 'yearly' || v === 'annually') return 'annual';
  return 'monthly';
}

function normalizeTier(t){
  const v = String(t || '').toLowerCase();
  return v === 'business' ? 'business' : 'member';
}

function normalizeBizTier(bt){
  const v = String(bt || '').toLowerCase();
  if(v === 'pro' || v === 'professional') return 'pro';
  return 'starter';
}

function normalizeLocations(n){
  const x = Number(n);
  if(!Number.isFinite(x)) return 1;
  return Math.max(1, Math.min(50, Math.round(x)));
}

function loadStripePublicCfg(){
  if(_stripePublicCfg) return _stripePublicCfg;
  try{
    const cfgPath = path.join(__dirname, '../../site/assets/data/stripe_public_test.json');
    const raw = fs.readFileSync(cfgPath, 'utf8');
    _stripePublicCfg = JSON.parse(raw);
  }catch(e){
    _stripePublicCfg = null;
  }
  return _stripePublicCfg;
}

function envAny(...names){
  for(const n of names){
    const v = process.env[n];
    if(v && String(v).trim()) return String(v).trim();
  }
  return '';
}

function resolvePriceId({ tier, plan, biz_tier }){
  // Prefer explicit env price IDs (matches docs + status page)
  if(tier === 'member'){
    if(plan === 'annual'){
      const v = envAny('PRICE_ID_MEMBER_ANNUAL', 'STRIPE_PRICE_MEMBER_ANNUAL');
      if(v) return v;
    }else{
      const v = envAny('PRICE_ID_MEMBER_MONTHLY', 'STRIPE_PRICE_MEMBER_MONTHLY');
      if(v) return v;
    }
  }

  if(tier === 'business'){
    const bt = biz_tier || 'starter';
    if(bt === 'pro'){
      if(plan === 'annual'){
        const v = envAny('PRICE_ID_BIZ_PRO_ANNUAL', 'STRIPE_PRICE_BIZ_PRO_ANNUAL');
        if(v) return v;
      }else{
        const v = envAny('PRICE_ID_BIZ_PRO_MONTHLY', 'STRIPE_PRICE_BIZ_PRO_MONTHLY');
        if(v) return v;
      }
    }else{
      if(plan === 'annual'){
        const v = envAny('PRICE_ID_BIZ_STARTER_ANNUAL', 'STRIPE_PRICE_BIZ_STARTER_ANNUAL', 'PRICE_ID_BIZ_ANNUAL', 'STRIPE_PRICE_BIZ_ANNUAL');
        if(v) return v;
      }else{
        const v = envAny('PRICE_ID_BIZ_STARTER_MONTHLY', 'STRIPE_PRICE_BIZ_STARTER_MONTHLY', 'PRICE_ID_BIZ_MONTHLY', 'STRIPE_PRICE_BIZ_MONTHLY');
        if(v) return v;
      }
    }
  }

  // Fallback to the repo config (test/public config)
  const cfg = loadStripePublicCfg();
  if(cfg?.prices){
    if(tier === 'member'){
      return plan === 'annual' ? (cfg.prices.member_annual || '') : (cfg.prices.member_monthly || '');
    }
    if(tier === 'business'){
      const bt = biz_tier || 'starter';
      if(cfg.prices.business_tiers?.[bt]){
        return plan === 'annual' ? (cfg.prices.business_tiers[bt].annual || '') : (cfg.prices.business_tiers[bt].monthly || '');
      }
      // legacy fallback
      return plan === 'annual' ? (cfg.prices.business_annual || '') : (cfg.prices.business_monthly || '');
    }
  }

  return '';
}

async function ensureTenantId({ tenant_slug, tenant_name, owner_user_id }){
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if(!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;

  const { createClient } = require('@supabase/supabase-js');
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  if(!tenant_slug) return null;

  // 1) lookup by slug
  const { data: existing, error: selErr } = await sb
    .from('tenants')
    .select('id, slug')
    .eq('slug', tenant_slug)
    .limit(1)
    .maybeSingle();
  if(selErr) throw selErr;
  if(existing?.id){
    // ensure tenant_users admin mapping when possible
    if(owner_user_id && isUuid(owner_user_id)){
      await sb
        .from('tenant_users')
        .upsert({ tenant_id: existing.id, user_id: owner_user_id, role: 'admin' }, { onConflict: 'tenant_id,user_id' });
    }
    return existing.id;
  }

  // 2) insert
  const insertPayload = {
    slug: tenant_slug,
    name: tenant_name || tenant_slug
  };
  const { data: created, error: insErr } = await sb
    .from('tenants')
    .insert(insertPayload)
    .select('id')
    .single();
  if(insErr) throw insErr;

  if(created?.id && owner_user_id && isUuid(owner_user_id)){
    await sb
      .from('tenant_users')
      .upsert({ tenant_id: created.id, user_id: owner_user_id, role: 'admin' }, { onConflict: 'tenant_id,user_id' });
  }

  return created?.id || null;
}

exports.handler = async (event) => {
  const headers = corsHeaders(event);

  if(event.httpMethod === 'OPTIONS'){
    return { statusCode: 200, headers, body: '' };
  }

  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  if(!STRIPE_SECRET_KEY){
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing STRIPE_SECRET_KEY in environment.' }) };
  }

  const payload = safeJsonParse(event.body);
  if(!payload){
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body.' }) };
  }

  const tier = normalizeTier(payload.tier);
  const plan = normalizePlan(payload.plan);
  const biz_tier = normalizeBizTier(payload.biz_tier);
  const locations = normalizeLocations(payload.locations);
  const email = String(payload.email || '').trim();
  const subject_id_user = String(payload.subject_id || '').trim();
  const tenant_slug = String(payload.tenant_slug || '').trim();
  const tenant_name = String(payload.tenant_name || '').trim();

  // Require login for real checkouts (subject_id must be a UUID)
  if(!isUuid(subject_id_user)){
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing/invalid subject_id. Please log in and try again.' }) };
  }

  const origin = getOrigin(event);

  const priceId = resolvePriceId({ tier, plan, biz_tier });
  if(!priceId){
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'No Stripe price ID configured for this plan. Set PRICE_ID_* env vars (see /admin/status) or update stripe_public_test.json.'
      })
    };
  }

  // Determine subscription subject (user vs tenant)
  let subject_type = 'user';
  let subject_id = subject_id_user;
  if(tier === 'business'){
    try{
      const tenantId = await ensureTenantId({ tenant_slug, tenant_name, owner_user_id: subject_id_user });
      if(tenantId){
        subject_type = 'tenant';
        subject_id = tenantId;
      }
    }catch(e){
      // If tenant creation fails, we still allow checkout as user-bound subscription,
      // but we surface a warning in logs.
      console.warn('Tenant ensure failed; falling back to user subscription:', e?.message || e);
    }
  }

  const plan_key = tier === 'business'
    ? `business_${biz_tier}_${plan}`
    : `member_${plan}`;

  const stripe = Stripe(STRIPE_SECRET_KEY);

  const sessionMetadata = {
    subject_type,
    subject_id,
    tier,
    plan,
    plan_key,
    biz_tier: tier === 'business' ? biz_tier : '',
    locations: tier === 'business' ? String(locations) : '',

    // Optional NDYRA context (safe for all tiers)
    flow: payload.flow ? String(payload.flow) : '',
    tenant_id: payload.tenant_id ? String(payload.tenant_id) : '',
    tenant_slug: payload.tenant_slug ? String(payload.tenant_slug) : (tier === 'business' ? tenant_slug : ''),
    tenant_name: tier === 'business' ? tenant_name : ''
  };

  const isBiz = tier === 'business';

  // Allow caller to provide explicit return URLs, but keep them same-origin.
  const sanitizeReturnUrl = (maybeUrl) => {
    if(!maybeUrl) return null;
    try{
      const u = new URL(maybeUrl, origin);
      if(u.origin !== origin) return null;
      return u.toString();
    }catch(e){
      return null;
    }
  };

  const defaultSuccessUrl = `${origin}${isBiz ? '/biz/account/' : '/app/account/'}?checkout=success&tier=${encodeURIComponent(tier)}&plan=${encodeURIComponent(plan)}&session_id={CHECKOUT_SESSION_ID}`;
  const defaultCancelUrl = `${origin}${isBiz ? '/for-gyms/' : '/join.html'}?checkout=cancel&tier=${encodeURIComponent(tier)}&plan=${encodeURIComponent(plan)}`;

  const successUrl = sanitizeReturnUrl(payload.success_url) || defaultSuccessUrl;
  const cancelUrl  = sanitizeReturnUrl(payload.cancel_url)  || defaultCancelUrl;

  try{
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: email || undefined,
      allow_promotion_codes: true,
      line_items: [{ price: priceId, quantity: tier === 'business' ? locations : 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: sessionMetadata,
      subscription_data: {
        metadata: sessionMetadata
      }
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        url: session.url,
        id: session.id
      })
    };
  }catch(err){
    console.error('Stripe checkout session create failed:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Failed to create checkout session.',
        message: err?.message || String(err)
      })
    };
  }
};

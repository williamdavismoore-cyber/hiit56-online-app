// netlify/functions/stripe_webhook.js
// Stripe webhook → mirrors subscription state into Supabase.
//
// Expected Supabase tables (see supabase_schema.sql):
// - subscriptions (subject_type: 'user' | 'tenant')
// - entitlements (optional convenience mirror)
// - stripe_events (optional; if present we store raw events)

'use strict';

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isUuid(v){ return UUID_RE.test(String(v||'')); }

function getSupabase(){
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if(!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY){
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

function getStripe(){
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  if(!STRIPE_SECRET_KEY) throw new Error('Missing STRIPE_SECRET_KEY');
  return Stripe(STRIPE_SECRET_KEY);
}

function toIsoFromUnixSeconds(s){
  if(!s) return null;
  const ms = Number(s) * 1000;
  if(!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

async function maybeRecordStripeEvent(supabase, evt){
  // Some projects have a stripe_events table; others don't.
  // We try to insert, but never fail the webhook if it errors.
  try{
    await supabase
      .from('stripe_events')
      .insert({
        stripe_event_id: evt.id,
        type: evt.type,
        created: toIsoFromUnixSeconds(evt.created),
        livemode: !!evt.livemode,
        payload: evt
      });
  }catch(_e){
    // swallow
  }
}

async function resolveUserIdFallback({ stripe, supabase, customerId }){
  try{
    const cust = await stripe.customers.retrieve(customerId);
    const email = (cust && typeof cust === 'object') ? (cust.email || '') : '';
    if(!email) return null;

    const { data, error } = await supabase
      .from('profiles')
      .select('user_id')
      .eq('email', email)
      .limit(1)
      .maybeSingle();

    if(error) return null;
    return data?.user_id || null;
  }catch{
    return null;
  }
}

function normalizeSubjectType(v){
  const s = String(v || '').toLowerCase();
  if(s === 'tenant') return 'tenant';
  return 'user';
}

function deriveTierKey({ md, sub }){
  // Prefer explicit plan_key metadata from checkout session.
  if(md?.plan_key) return String(md.plan_key);

  // Fallback: derive from recurring interval
  const interval = sub?.items?.data?.[0]?.price?.recurring?.interval;
  if(interval === 'year') return 'member_annual';
  return 'member_monthly';
}

async function upsertSubscriptionMirror({ supabase, stripe, sub }){
  const md = sub.metadata || {};

  let subject_type = normalizeSubjectType(md.subject_type);
  let subject_id = String(md.subject_id || '').trim();

  // Fallback: if no subject_id in metadata, attempt to resolve by customer email → profiles.user_id
  if(!isUuid(subject_id) && String(sub.customer || '').startsWith('cus_')){
    const fallbackUserId = await resolveUserIdFallback({ stripe, supabase, customerId: String(sub.customer) });
    if(isUuid(fallbackUserId)){
      subject_type = 'user';
      subject_id = fallbackUserId;
    }
  }

  if(!isUuid(subject_id)){
    // We can't safely write a subscription row without a valid subject_id.
    console.warn('Webhook: missing/invalid subject_id; skipping subscription mirror', {
      stripe_subscription_id: sub.id,
      subject_type,
      subject_id
    });
    return;
  }

  const tierKey = deriveTierKey({ md, sub });

  const payload = {
    subject_type,
    subject_id,
    stripe_customer_id: String(sub.customer || ''),
    stripe_subscription_id: sub.id,
    status: sub.status,
    tier: tierKey,
    current_period_end: toIsoFromUnixSeconds(sub.current_period_end)
  };

  const { error } = await supabase
    .from('subscriptions')
    .upsert(payload, { onConflict: 'stripe_subscription_id' });

  if(error){
    console.error('Webhook: subscriptions upsert failed', error);
    throw error;
  }

  // Optional convenience entitlement mirror
  const entStatus = (sub.status === 'active' || sub.status === 'trialing') ? 'active' : 'inactive';
  const ent = {
    subject_type,
    subject_id,
    feature_key: `plan:${tierKey}`,
    kind: 'plan',
    status: entStatus,
    valid_until: toIsoFromUnixSeconds(sub.current_period_end),
    value: {
      stripe_subscription_id: sub.id,
      stripe_customer_id: String(sub.customer || ''),
      tier: tierKey,
      status: sub.status
    }
  };

  try{
    await supabase
      .from('entitlements')
      .upsert(ent, { onConflict: 'subject_type,subject_id,feature_key' });
  }catch(_e){
    // Entitlements aren't required for core billing; don't fail webhook.
  }
}

exports.handler = async (event) => {
  const STRIPE_WEBHOOK_SIGNING_SECRET = process.env.STRIPE_WEBHOOK_SIGNING_SECRET;
  if(!STRIPE_WEBHOOK_SIGNING_SECRET){
    return { statusCode: 500, body: 'Missing STRIPE_WEBHOOK_SIGNING_SECRET' };
  }

  try{
    const stripe = getStripe();
    const supabase = getSupabase();

    const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
    if(!sig) return { statusCode: 400, body: 'Missing stripe-signature header' };

    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64').toString('utf8')
      : (event.body || '');

    const stripeEvent = stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SIGNING_SECRET);

    await maybeRecordStripeEvent(supabase, stripeEvent);

    // We mirror subscription state off subscription.* events.
    switch(stripeEvent.type){
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = stripeEvent.data.object;
        await upsertSubscriptionMirror({ supabase, stripe, sub });
        break;
      }
      // checkout.session.completed can be useful for debugging, but subscription events are the source of truth.
      case 'checkout.session.completed':
        break;
      default:
        break;
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  }catch(err){
    console.error('Stripe webhook error:', err);
    return { statusCode: 400, body: `Webhook error: ${err.message || err}` };
  }
};

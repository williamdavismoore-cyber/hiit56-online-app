// netlify/functions/stripe_webhook.js
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

    const stripeSecret = process.env.STRIPE_SECRET_KEY;
    const whsec = process.env.STRIPE_WEBHOOK_SIGNING_SECRET;
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseSecret = process.env.SUPABASE_SECRET_KEY;

    if (!stripeSecret) return json(500, { error: 'Missing STRIPE_SECRET_KEY' });
    if (!whsec) return json(500, { error: 'Missing STRIPE_WEBHOOK_SIGNING_SECRET' });
    if (!supabaseUrl) return json(500, { error: 'Missing SUPABASE_URL' });
    if (!supabaseSecret) return json(500, { error: 'Missing SUPABASE_SECRET_KEY' });

    const stripe = Stripe(stripeSecret);
    const sig = event.headers?.['stripe-signature'] || event.headers?.['Stripe-Signature'];
    if (!sig) return json(400, { error: 'Missing stripe-signature header' });

    let rawBody = event.body || '';
    if (event.isBase64Encoded) rawBody = Buffer.from(rawBody, 'base64').toString('utf8');

    let stripeEvent;
    try {
      stripeEvent = stripe.webhooks.constructEvent(rawBody, sig, whsec);
    } catch (err) {
      console.error('Signature verification failed:', err.message);
      return json(400, { error: 'Invalid signature' });
    }

    const supabase = createClient(supabaseUrl, supabaseSecret, { auth: { persistSession: false } });

    // ---- Idempotency: record event first
    const { error: insertError } = await supabase
      .from('stripe_events')
      .insert({
        id: stripeEvent.id,
        type: stripeEvent.type,
        created: new Date(stripeEvent.created * 1000).toISOString(),
        livemode: stripeEvent.livemode,
        payload: stripeEvent,
      });

    if (insertError && insertError.code === '23505') {
      return json(200, { received: true, duplicate: true });
    }

    const markEventError = async (msg) => {
      try {
        await supabase.from('stripe_events').update({ error: msg }).eq('id', stripeEvent.id);
      } catch (_) {}
    };

    const resolveProfileIdByEmail = async (email) => {
      if (!email) return null;
      const { data, error } = await supabase
        .from('profiles')
        .select('user_id')
        .eq('email', email)
        .maybeSingle();
      if (error) throw error;
      return data?.user_id || null;
    };

    const upsertSubscriptionMirror = async ({
      subject_type,
      subject_id,
      tier,
      status,
      stripe_customer_id,
      stripe_subscription_id,
      current_period_end,
    }) => {
      if (!stripe_subscription_id) return;

      const payload = {
        subject_type: subject_type,
        subject_id: subject_id,
        tier: tier || 'member',
        status: status || 'unknown',
        stripe_customer_id: stripe_customer_id || null,
        stripe_subscription_id,
        current_period_end: current_period_end || null,
        updated_at: new Date().toISOString(),
      };

      const { error } = await supabase
        .from('subscriptions')
        .upsert(payload, { onConflict: 'stripe_subscription_id' });

      if (error) throw error;
    };

    const insertEntitlement = async ({ subject_type, subject_id, status, plan_key, valid_until }) => {
      if (!subject_id) return;
      const active = status === 'active' || status === 'trialing';
      const { error } = await supabase.from('entitlements').insert({
        subject_type,
        subject_id,
        kind: 'member_access',
        value: { active, plan_key: plan_key || null },
        valid_from: new Date().toISOString(),
        valid_until: valid_until || null,
        created_by: null,
      });
      if (error) throw error;
    };

    try {
      switch (stripeEvent.type) {
        case 'checkout.session.completed': {
          const session = stripeEvent.data.object;
          const meta = session?.metadata || {};

          // ✅ canonical default for member subs in your DB is 'user'
          let subject_type = (meta.subject_type || 'user').trim();
          let subject_id = (meta.subject_id || '').trim();

          const tier = (meta.tier || 'member').trim();
          const plan_key = (meta.plan_key || null);

          const email = session?.customer_details?.email || session?.customer_email || null;
          const fullName = session?.customer_details?.name || null;

          // Fallback ONLY if subject_id missing
          if (!subject_id) {
            subject_id = await resolveProfileIdByEmail(email);
          }

          if (!subject_id) {
            await markEventError('Missing subject_id (no metadata + no matching profile by email).');
            return json(200, { received: true, missing_subject: true });
          }

          // (Optional) Ensure profile exists. Your profiles table stores auth user_id as user_id.
          // Only makes sense for member subject_type='user'
          if (subject_type === 'user') {
            try {
              await supabase.from('profiles').upsert(
                { user_id: subject_id, email: email || null, full_name: fullName || null },
                { onConflict: 'user_id' }
              );
            } catch (e) {
              console.warn('profiles upsert (webhook fallback) failed:', e?.message || e);
            }
          }

          const stripeCustomerId = session?.customer || null;
          const stripeSubscriptionId = session?.subscription || null;

          if (!stripeSubscriptionId) {
            await markEventError('checkout.session.completed missing subscription id');
            return json(200, { received: true, missing_subscription: true });
          }

          const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
          const status = sub?.status || 'unknown';
          const currentPeriodEnd = sub?.current_period_end
            ? new Date(sub.current_period_end * 1000).toISOString()
            : null;

          await upsertSubscriptionMirror({
            subject_type,
            subject_id,
            tier,
            status,
            stripe_customer_id: stripeCustomerId,
            stripe_subscription_id: stripeSubscriptionId,
            current_period_end: currentPeriodEnd,
          });

          // Entitlement write (keep subject_type consistent)
          await insertEntitlement({
            subject_type,
            subject_id,
            status,
            plan_key,
            valid_until: currentPeriodEnd,
          });

          break;
        }

        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted': {
          const sub = stripeEvent.data.object;

          const stripeSubscriptionId = sub?.id;
          const stripeCustomerId = sub?.customer || null;
          const status = sub?.status || (stripeEvent.type === 'customer.subscription.deleted' ? 'canceled' : 'unknown');
          const currentPeriodEnd = sub?.current_period_end
            ? new Date(sub.current_period_end * 1000).toISOString()
            : null;

          const meta = sub?.metadata || {};
          const subject_type = (meta.subject_type || 'user').trim();
          const subject_id = (meta.subject_id || '').trim();
          const tier = (meta.tier || 'member').trim();
          const plan_key = (meta.plan_key || null);

          if (subject_id) {
            await upsertSubscriptionMirror({
              subject_type,
              subject_id,
              tier,
              status,
              stripe_customer_id: stripeCustomerId,
              stripe_subscription_id: stripeSubscriptionId,
              current_period_end: currentPeriodEnd,
            });

            await insertEntitlement({
              subject_type,
              subject_id,
              status,
              plan_key,
              valid_until: currentPeriodEnd,
            });
          } else {
            // minimal update if row already exists
            await supabase
              .from('subscriptions')
              .update({
                status,
                current_period_end: currentPeriodEnd,
                updated_at: new Date().toISOString(),
              })
              .eq('stripe_subscription_id', stripeSubscriptionId);
          }

          break;
        }

        default:
          break;
      }

      return json(200, { received: true });
    } catch (err) {
      console.error('Webhook processing error:', err);
      await markEventError(err.message || 'Processing error');
      return json(200, { received: true, error_logged: true });
    }
  } catch (err) {
    console.error('Fatal webhook error:', err);
    return json(500, { error: 'Fatal webhook error' });
  }
};

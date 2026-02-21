import { createClient } from '@supabase/supabase-js';

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    },
    body: JSON.stringify(obj)
  };
}

function getBearerToken(headers = {}) {
  const raw = headers.authorization || headers.Authorization;
  if (!raw) return null;
  const m = String(raw).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

export async function handler(event) {
  try {
    if (event.httpMethod !== 'POST') {
      return json(405, { error: 'method_not_allowed' });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SECRET_KEY;
    const SUPABASE_ANON = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE || !SUPABASE_ANON) {
      return json(500, { error: 'missing_env', hint: 'Set SUPABASE_URL, SUPABASE_SECRET_KEY, VITE_SUPABASE_PUBLISHABLE_KEY' });
    }

    const token = getBearerToken(event.headers);
    if (!token) {
      return json(401, { error: 'missing_auth' });
    }

    const body = JSON.parse(event.body || '{}');
    const tenant_id = body.tenant_id;
    const title = body.title;
    const body_md = body.body_md;

    if (!tenant_id || !title || !body_md) {
      return json(400, { error: 'bad_request', hint: 'tenant_id, title, body_md required' });
    }

    // 1) Identify caller
    const supaAuth = createClient(SUPABASE_URL, SUPABASE_ANON, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });

    const { data: userData, error: userErr } = await supaAuth.auth.getUser(token);
    if (userErr || !userData?.user) {
      return json(401, { error: 'invalid_auth' });
    }

    const actor_user_id = userData.user.id;

    // 2) Verify staff/admin
    const supaAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });

    const { data: staffRow, error: staffErr } = await supaAdmin
      .from('tenant_users')
      .select('role')
      .eq('tenant_id', tenant_id)
      .eq('user_id', actor_user_id)
      .maybeSingle();

    if (staffErr) {
      return json(500, { error: 'staff_lookup_failed' });
    }

    const role = staffRow?.role || null;
    const isStaff = role === 'admin' || role === 'staff';

    if (!isStaff) {
      return json(403, { error: 'forbidden', hint: 'tenant staff required' });
    }

    // 3) Determine next version (strictly increments)
    const { data: tenant, error: tenantErr } = await supaAdmin
      .from('tenants')
      .select('active_waiver_version')
      .eq('id', tenant_id)
      .single();

    if (tenantErr) {
      return json(400, { error: 'tenant_not_found' });
    }

    const prev = Number(tenant.active_waiver_version || 0);
    const next = prev + 1;

    // 4) Insert immutable template
    const { error: insErr } = await supaAdmin
      .from('waiver_templates')
      .insert({ tenant_id, version: next, title, body_md, created_by: actor_user_id });

    if (insErr) {
      return json(500, { error: 'insert_failed', details: insErr.message });
    }

    // 5) Activate by updating tenant.active_waiver_version
    const { error: updErr } = await supaAdmin
      .from('tenants')
      .update({ active_waiver_version: next })
      .eq('id', tenant_id);

    if (updErr) {
      return json(500, { error: 'activate_failed', details: updErr.message });
    }

    // 6) Audit
    await supaAdmin
      .from('audit_log')
      .insert({
        tenant_id,
        actor_user_id,
        action: 'waiver_template_update',
        details: { prev_version: prev, next_version: next, title_len: String(title).length }
      });

    return json(200, { ok: true, tenant_id, version: next });
  } catch (e) {
    return json(500, { error: 'server_error', details: e?.message || String(e) });
  }
}

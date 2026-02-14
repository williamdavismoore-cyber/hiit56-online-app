// site/assets/js/supabaseClient.js
// Loads Supabase public config from /assets/data/supabase_public_test.json
// Requires the Supabase browser SDK to be loaded first: /assets/vendor/supabase/supabase.js

async function loadSupabasePublicConfig() {
  const res = await fetch('/assets/data/supabase_public_test.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('Missing /assets/data/supabase_public_test.json');
  return await res.json();
}

let _supabase = null;

export async function getSupabase() {
  if (_supabase) return _supabase;

  if (!window.supabase || !window.supabase.createClient) {
    throw new Error('Supabase browser SDK not loaded. Include /assets/vendor/supabase/supabase.js before using getSupabase().');
  }

  const cfg = await loadSupabasePublicConfig();
  const url = String(cfg.supabase_url || '').trim();
  const key = String(cfg.supabase_anon_key || '').trim();

  if (!url) throw new Error('supabase_url missing in supabase_public_test.json');
  if (!key) throw new Error('supabase_anon_key missing in supabase_public_test.json');

  _supabase = window.supabase.createClient(url, key);
  return _supabase;
}

// PUBLIC config endpoint.
// Purpose: provide *public* client-side config values to the static frontend
// without committing them into the repo.
//
// IMPORTANT: Only return values that are safe to expose in the browser.
// - Supabase URL + anon/publishable key are intended to be public.
// - Never return service-role keys.

exports.handler = async () => {
  const supabaseUrl =
    process.env.VITE_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    '';

  const supabaseAnonKey =
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    '';

  // Return BOTH camelCase and snake_case keys for backward compatibility.
  // The frontend prefers camelCase.
  const payload = {
    supabaseUrl,
    supabaseAnonKey,
    supabase_url: supabaseUrl,
    supabase_anon_key: supabaseAnonKey,
  };

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(payload),
  };
};

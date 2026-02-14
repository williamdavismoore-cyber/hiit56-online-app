// site/assets/js/ensureProfile.js
import { getSupabase } from './supabaseClient.js';

export async function ensureProfile(user) {
  if (!user?.id) return;

  const supabase = await getSupabase();

  const payload = {
    user_id: user.id,
    email: user.email ?? null,
    full_name: user.user_metadata?.full_name ?? null,
  };

  const { error } = await supabase
    .from('profiles')
    .upsert(payload, { onConflict: 'user_id' });

  if (error) console.error('[ensureProfile] upsert failed:', error);
}

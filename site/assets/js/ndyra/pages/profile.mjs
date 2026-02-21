import { requireAuth, getSupabase } from '../lib/supabase.mjs';
import { makeEl, toast, formatTimeAgo } from '../lib/utils.mjs';
import { renderPostCard } from '../components/postCard.mjs';

const PAGE_SIZE = 10;

const METRIC_KEYS = [
  'resting_hr',
  'hrv',
  'vo2',
  'weekly_minutes',
  'streak',
];

const PRIVACY_DEFAULTS = {
  allow_follow_requests: true,
  show_profile_public: true,
  show_posts_public: true,
  show_biometrics_public: false,
};

function qs(sel, root=document){ return root.querySelector(sel); }
function qsa(sel, root=document){ return Array.from(root.querySelectorAll(sel)); }

function isDemoMode(){
  return new URLSearchParams(location.search).get('src') === 'demo';
}

function metricsKey(subject){
  return `ndyra:profile:metrics:${subject}`;
}

function loadMetrics(subject){
  try {
    const raw = localStorage.getItem(metricsKey(subject));
    const json = raw ? JSON.parse(raw) : {};
    const out = {};
    for(const k of METRIC_KEYS){
      const v = json[k];
      out[k] = (v === 0 || v) ? v : '';
    }
    return out;
  } catch {
    const out = {};
    for(const k of METRIC_KEYS) out[k] = '';
    return out;
  }
}

function saveMetrics(subject, metrics){
  try {
    localStorage.setItem(metricsKey(subject), JSON.stringify(metrics));
  } catch {}
}

function setMetricUI(metrics){
  for(const k of METRIC_KEYS){
    const el = qs(`[data-metric-value="${k}"]`);
    if(!el) continue;
    el.textContent = (metrics[k] === 0 || metrics[k]) ? String(metrics[k]) : '—';
  }
}

function openModal(name){
  const m = qs(`[data-modal="${name}"]`);
  if(!m) return;
  m.classList.add('open');
  m.setAttribute('aria-hidden', 'false');
}

function closeModal(modalEl){
  modalEl?.classList?.remove('open');
  modalEl?.setAttribute?.('aria-hidden', 'true');
}

function wireModalClose(){
  qsa('[data-modal]').forEach(m => {
    m.addEventListener('click', (e) => {
      if(e.target === m) closeModal(m);
    });
  });

  qsa('[data-modal-close]').forEach(btn => {
    btn.addEventListener('click', () => {
      const m = btn.closest('[data-modal]');
      closeModal(m);
    });
  });

  document.addEventListener('keydown', (e) => {
    if(e.key !== 'Escape') return;
    const m = qs('[data-modal].open');
    if(m) closeModal(m);
  });
}

function demoProfile(){
  return {
    user_id: 'demo-user-a',
    full_name: 'NDYRA Team',
    handle: 'ndyra_team',
    avatar_url: '/assets/branding/app-icon-192.png',
    created_at: new Date(Date.now() - 1000*60*60*24*120).toISOString(),
  };
}

function renderProfileHeader(profile, stats){
  const avatar = qs('[data-profile-avatar]');
  const name = qs('[data-profile-name]');
  const handle = qs('[data-profile-handle]');
  const sub = qs('[data-profile-sub]');

  const displayName = profile?.full_name || profile?.display_name || '—';
  const h = profile?.handle || (profile?.email ? profile.email.split('@')[0] : null);

  if(avatar) avatar.src = profile?.avatar_url || '/assets/branding/app-icon-192.png';
  if(name) name.textContent = displayName;
  if(handle) handle.textContent = h ? `@${String(h).replace(/^@/, '')}` : '@—';

  if(sub){
    const joined = profile?.created_at ? `Joined ${formatTimeAgo(profile.created_at)}` : '—';
    sub.textContent = joined;
  }

  // Stats
  const postsEl = qs('[data-stat-posts]');
  const followersEl = qs('[data-stat-followers]');
  const followingEl = qs('[data-stat-following]');

  if(postsEl) postsEl.textContent = String(stats?.posts_count ?? 0);
  if(followersEl) followersEl.textContent = String(stats?.followers_count ?? 0);
  if(followingEl) followingEl.textContent = String(stats?.following_count ?? 0);
}

function setPostsMeta(text){
  const el = qs('[data-posts-meta]');
  if(el) el.textContent = text;
}

function clearPosts(){
  const root = qs('[data-profile-posts]');
  if(root) root.innerHTML = '';
}

function appendPostCard(post, profileMap){
  const root = qs('[data-profile-posts]');
  if(!root) return;
  const card = renderPostCard(post, profileMap);

  // Add an explicit open link for now (keeps routing stable in static env)
  const actions = makeEl('div', { className:'row', style:'justify-content:flex-end;gap:10px;margin-top:10px;' }, [
    makeEl('a', { className:'btn outline', href:`/app/post/?id=${encodeURIComponent(post.id)}`, title:'Open post' }, ['Open']),
  ]);
  card.appendChild(actions);

  root.appendChild(card);
}

async function fetchProfileAndStats(supabase, userId){
  const out = { profile:null, stats:{ posts_count:0, followers_count:0, following_count:0 } };

  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle?.() ?? await supabase.from('profiles').select('*').eq('user_id', userId).single();

    if(!error) out.profile = data;
  } catch (e) {
    console.warn('[NDYRA] profile load failed', e);
  }

  // profile_stats is optional early-on; fail soft.
  try {
    const r = await supabase
      .from('profile_stats')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle?.();
    if(r?.data){
      out.stats.posts_count = r.data.posts_count ?? out.stats.posts_count;
      out.stats.followers_count = r.data.followers_count ?? out.stats.followers_count;
      out.stats.following_count = r.data.following_count ?? out.stats.following_count;
    }
  } catch {
    // ignore
  }

  return out;
}

async function fetchPrivacySettings(supabase, userId){
  try {
    const r = await supabase
      .from('privacy_settings')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle?.();

    if(r?.data) return { ...PRIVACY_DEFAULTS, ...r.data };
  } catch {
    // ignore (table might not exist in earlier schema)
  }

  // fallback local
  try {
    const raw = localStorage.getItem(`ndyra:privacy:${userId}`);
    const json = raw ? JSON.parse(raw) : {};
    return { ...PRIVACY_DEFAULTS, ...json };
  } catch {
    return { ...PRIVACY_DEFAULTS };
  }
}

async function savePrivacySettings(supabase, userId, settings){
  // Attempt DB first (preferred)
  try {
    const payload = {
      user_id: userId,
      allow_follow_requests: Boolean(settings.allow_follow_requests),
      show_profile_public: Boolean(settings.show_profile_public),
      show_posts_public: Boolean(settings.show_posts_public),
      show_biometrics_public: Boolean(settings.show_biometrics_public),
      updated_at: new Date().toISOString(),
    };

    const r = await supabase
      .from('privacy_settings')
      .upsert(payload, { onConflict: 'user_id' });

    if(!r?.error) return { ok:true, mode:'db' };
  } catch {
    // ignore
  }

  // Local fallback
  try {
    localStorage.setItem(`ndyra:privacy:${userId}`, JSON.stringify(settings));
  } catch {}
  return { ok:true, mode:'local' };
}

function setPrivacyUI(settings){
  qsa('[data-privacy]').forEach(input => {
    const k = input.getAttribute('data-privacy');
    input.checked = Boolean(settings[k]);
  });
}

function readPrivacyUI(){
  const out = { ...PRIVACY_DEFAULTS };
  qsa('[data-privacy]').forEach(input => {
    const k = input.getAttribute('data-privacy');
    out[k] = Boolean(input.checked);
  });
  return out;
}

async function loadMyPosts(supabase, userId, cursor){
  let q = supabase
    .from('posts')
    .select('*')
    .eq('author_user_id', userId)
    .order('created_at', { ascending:false })
    .limit(PAGE_SIZE);

  if(cursor) q = q.lt('created_at', cursor);

  const { data, error } = await q;
  if(error) throw error;
  return data || [];
}

export async function init(){
  wireModalClose();

  const demo = isDemoMode();

  let user = null;
  let supabase = null;

  if(!demo){
    user = await requireAuth({ next: location.pathname + location.search });
    if(!user) return;
    supabase = getSupabase();
  }

  // Metrics (local-only for now)
  const metricsSubject = demo ? 'demo' : user.id;
  const metrics = loadMetrics(metricsSubject);
  setMetricUI(metrics);

  const metricsBtn = qs('[data-metrics-edit]');
  if(metricsBtn){
    metricsBtn.addEventListener('click', () => openModal('metrics'));
  }

  // Clicking a tile opens the editor too
  qsa('[data-metric]').forEach(tile => {
    tile.addEventListener('click', () => {
      openModal('metrics');
      const k = tile.getAttribute('data-metric');
      const input = qs(`[data-metrics-input="${k}"]`);
      input?.focus?.();
    });
  });

  // Populate metrics modal inputs
  qsa('[data-metrics-input]').forEach(inp => {
    const k = inp.getAttribute('data-metrics-input');
    inp.value = metrics[k] ?? '';
  });

  const saveMetricsBtn = qs('[data-save-metrics]');
  if(saveMetricsBtn){
    saveMetricsBtn.addEventListener('click', () => {
      const next = { ...metrics };
      qsa('[data-metrics-input]').forEach(inp => {
        const k = inp.getAttribute('data-metrics-input');
        const raw = inp.value.trim();
        next[k] = raw === '' ? '' : Number(raw);
      });
      Object.assign(metrics, next);
      saveMetrics(metricsSubject, metrics);
      setMetricUI(metrics);
      toast('Performance strip saved');
      closeModal(qs('[data-modal="metrics"]'));
    });
  }

  // Profile data
  let profile = demo ? demoProfile() : null;
  let stats = { posts_count:0, followers_count:0, following_count:0 };

  if(!demo){
    const r = await fetchProfileAndStats(supabase, user.id);
    profile = r.profile || { user_id:user.id, full_name:user.user_metadata?.full_name || user.email || '—', email:user.email };
    stats = r.stats;
  }

  renderProfileHeader(profile, stats);

  // Edit Profile
  const editBtn = qs('[data-profile-edit]');
  if(editBtn){
    editBtn.addEventListener('click', () => {
      qs('[data-edit-name]').value = profile?.full_name || '';
      qs('[data-edit-handle]').value = profile?.handle || '';
      qs('[data-edit-avatar]').value = profile?.avatar_url || '';
      openModal('edit-profile');
    });
  }

  const saveProfileBtn = qs('[data-save-profile]');
  if(saveProfileBtn){
    saveProfileBtn.addEventListener('click', async () => {
      const nextName = qs('[data-edit-name]').value.trim();
      const nextHandle = qs('[data-edit-handle]').value.trim().replace(/^@/, '');
      const nextAvatar = qs('[data-edit-avatar]').value.trim();

      profile.full_name = nextName || profile.full_name;
      if(nextAvatar) profile.avatar_url = nextAvatar;
      if(nextHandle) profile.handle = nextHandle;

      if(!demo){
        // Update only columns that exist on the fetched profile object
        const patch = {};
        if('full_name' in profile) patch.full_name = nextName || null;
        if('avatar_url' in profile) patch.avatar_url = nextAvatar || null;
        if('handle' in profile && nextHandle) patch.handle = nextHandle;

        try {
          const { error } = await supabase
            .from('profiles')
            .update(patch)
            .eq('user_id', user.id);
          if(error) throw error;
          toast('Profile saved');
        } catch (e) {
          console.warn('[NDYRA] profile save failed', e);
          toast('Could not save profile (schema mismatch?)');
        }
      } else {
        toast('Demo mode: profile changes are not persisted');
      }

      renderProfileHeader(profile, stats);
      closeModal(qs('[data-modal="edit-profile"]'));
    });
  }

  // Privacy
  const privacyBtn = qs('[data-profile-privacy]');
  if(privacyBtn){
    privacyBtn.addEventListener('click', async () => {
      if(demo){
        setPrivacyUI(PRIVACY_DEFAULTS);
        openModal('privacy');
        return;
      }

      const settings = await fetchPrivacySettings(supabase, user.id);
      setPrivacyUI(settings);
      openModal('privacy');
    });
  }

  const savePrivacyBtn = qs('[data-save-privacy]');
  if(savePrivacyBtn){
    savePrivacyBtn.addEventListener('click', async () => {
      const settings = readPrivacyUI();

      if(demo){
        toast('Demo mode: privacy settings are local-only');
        closeModal(qs('[data-modal="privacy"]'));
        return;
      }

      const r = await savePrivacySettings(supabase, user.id, settings);
      toast(r.mode === 'db' ? 'Privacy saved' : 'Privacy saved (local)');
      closeModal(qs('[data-modal="privacy"]'));
    });
  }

  // Posts
  clearPosts();
  setPostsMeta('Loading posts…');

  const profileMap = new Map();
  if(profile?.user_id) profileMap.set(profile.user_id, profile);

  let cursor = null;
  let loaded = 0;
  const loadBtn = qs('[data-profile-loadmore]');

  async function loadMore(){
    try {
      let posts = [];
      if(demo){
        // Use demo feed json if present, otherwise just show the 3 embedded posts from FYP.
        const r = await fetch('/assets/data/ndyra_demo_posts.json', { cache:'no-store' }).catch(() => null);
        const json = r?.ok ? await r.json() : null;
        posts = (json?.posts || []).filter(p => p.author_user_id === profile.user_id);
        if(!posts.length){
          // fallback: show everything
          posts = (json?.posts || []).slice(0, 3);
        }
      } else {
        posts = await loadMyPosts(supabase, user.id, cursor);
      }

      if(!posts.length){
        if(!loaded) setPostsMeta('No posts yet. Create your first post from /app/create/.');
        if(loadBtn) loadBtn.hidden = true;
        return;
      }

      // For demo we just render once
      const batch = demo ? posts : posts;

      for(const p of batch){
        appendPostCard(p, profileMap);
        loaded++;
        cursor = p.created_at;
      }

      setPostsMeta(`${loaded} loaded`);

      // Hide loadmore when we don't have a full batch
      if(loadBtn){
        if(demo) loadBtn.hidden = true;
        else loadBtn.hidden = batch.length < PAGE_SIZE;
      }
    } catch (e) {
      console.warn('[NDYRA] load my posts failed', e);
      setPostsMeta('Could not load posts. Check Supabase + RLS.');
      if(loadBtn) loadBtn.hidden = true;
    }
  }

  if(loadBtn){
    loadBtn.addEventListener('click', loadMore);
  }

  await loadMore();
}

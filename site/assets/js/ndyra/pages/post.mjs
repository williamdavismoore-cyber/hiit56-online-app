import { qbool, qs, toast, markActiveNav } from '../lib/utils.mjs';
import { getSupabase, getUser } from '../lib/supabase.mjs';
import { renderPostCard } from '../components/postCard.mjs';

function pathPostId() {
  // Supports /app/post/:id (Netlify redirect) and ?id= fallback
  const q = qs('id');
  if (q) return q;

  const parts = window.location.pathname.split('/').filter(Boolean);
  const i = parts.findIndex((p) => p === 'post');
  if (i >= 0 && parts[i + 1] && parts[i + 1] !== 'index.html') return parts[i + 1];

  // last-ditch: last segment
  const last = parts[parts.length - 1];
  if (last && last !== 'post' && last !== 'index.html') return last;
  return null;
}

async function getDemoPosts() {
  const res = await fetch('/assets/data/ndyra_demo_posts.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('Demo data missing');
  return res.json();
}

function demoComments(postId) {
  // Minimal demo thread (no persistence)
  const now = new Date();
  const t0 = new Date(now.getTime() - 1000 * 60 * 18).toISOString();
  const t1 = new Date(now.getTime() - 1000 * 60 * 11).toISOString();
  const t2 = new Date(now.getTime() - 1000 * 60 * 5).toISOString();
  return [
    { id: `demo-c1-${postId}`, post_id: postId, user_id: 'demo-user-a', parent_id: null, body: 'NDYRA feels like a new era.', created_at: t0 },
    { id: `demo-c2-${postId}`, post_id: postId, user_id: 'demo-user-b', parent_id: null, body: 'The gates system is 🔥', created_at: t1 },
    { id: `demo-c3-${postId}`, post_id: postId, user_id: 'demo-user-c', parent_id: `demo-c2-${postId}`, body: 'No drift = no chaos. Love it.', created_at: t2 },
  ];
}

function fmtTime(ts) {
  try {
    const d = new Date(ts);
    // short-ish
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

function displayNameForUserId(userId) {
  if (!userId) return 'Unknown';
  if (userId.startsWith('demo-user-')) return userId.replace('demo-user-', 'Demo ');
  return 'User ' + String(userId).slice(0, 6);
}

function renderComments({ listEl, emptyEl, countEl, comments, onReply }) {
  listEl.innerHTML = '';
  const byParent = new Map();
  const top = [];
  for (const c of comments) {
    const pid = c.parent_id || null;
    if (!pid) top.push(c);
    if (!byParent.has(pid)) byParent.set(pid, []);
    byParent.get(pid).push(c);
  }
  top.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  const makeCard = (c, isReply = false) => {
    const card = document.createElement('div');
    card.className = 'comment-card' + (isReply ? ' reply' : '');
    const who = displayNameForUserId(c.user_id);
    const initial = who.trim().slice(0, 1).toUpperCase();

    card.innerHTML = `
      <div class="comment-avatar" aria-hidden="true">${initial}</div>
      <div class="comment-body">
        <div class="comment-meta">
          <div class="comment-name">${who}</div>
          <div class="comment-time">${fmtTime(c.created_at)}</div>
        </div>
        <div class="comment-text"></div>
        <div class="comment-actions"></div>
      </div>
    `;

    card.querySelector('.comment-text').textContent = c.body || '';

    const actions = card.querySelector('.comment-actions');
    // Reply only for top-level comments
    if (!isReply) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Reply';
      btn.addEventListener('click', () => onReply({ id: c.id, who }));
      actions.appendChild(btn);
    }

    return card;
  };

  for (const c of top) {
    const wrapper = document.createElement('div');
    wrapper.appendChild(makeCard(c, false));

    const replies = (byParent.get(c.id) || []).slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    if (replies.length) {
      const repliesEl = document.createElement('div');
      repliesEl.className = 'comment-replies';
      replies.forEach((r) => repliesEl.appendChild(makeCard(r, true)));
      wrapper.appendChild(repliesEl);
    }

    listEl.appendChild(wrapper);
  }

  const count = comments.length;
  if (countEl) countEl.textContent = String(count);
  if (emptyEl) emptyEl.hidden = count > 0;
}

async function fetchComments({ sb, postId, demoMode }) {
  if (demoMode) return demoComments(postId);

  const { data, error } = await sb
    .from('post_comments')
    .select('id, post_id, user_id, parent_id, body, created_at')
    .eq('post_id', postId)
    .eq('is_deleted', false)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return data || [];
}

function setupComposer({ sb, postId, demoMode }) {
  const composer = document.querySelector('[data-comment-composer]');
  const form = document.querySelector('[data-comment-form]');
  const input = document.querySelector('[data-comment-input]');
  const submit = document.querySelector('[data-comment-submit]');
  const loginBox = document.querySelector('[data-comment-login]');
  const loginLink = document.querySelector('[data-login-link]');
  const replyPill = document.querySelector('[data-reply-pill]');
  const replyToEl = document.querySelector('[data-reply-to]');
  const replyCancel = document.querySelector('[data-reply-cancel]');
  const statusEl = document.querySelector('[data-comment-submit-status]');

  let replyTo = null;

  const setStatus = (msg) => {
    if (!statusEl) return;
    statusEl.hidden = !msg;
    statusEl.textContent = msg || '';
  };

  const autosize = () => {
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  };

  const updateSubmit = () => {
    if (!submit) return;
    const ok = (input?.value || '').trim().length > 0;
    submit.disabled = !ok;
  };

  const setReply = ({ id, who }) => {
    replyTo = id;
    if (replyPill) replyPill.hidden = false;
    if (replyToEl) replyToEl.textContent = who || '…';
    input?.focus();
  };

  const clearReply = () => {
    replyTo = null;
    if (replyPill) replyPill.hidden = true;
    if (replyToEl) replyToEl.textContent = '';
  };

  replyCancel?.addEventListener('click', clearReply);

  input?.addEventListener('input', () => {
    autosize();
    updateSubmit();
  });

  const ensureAck = () => {
    const key = 'ndyra_comment_ack_v1';
    if (localStorage.getItem(key) === '1') return true;
    const ok = window.confirm('Quick reminder: keep it respectful. No harassment, no hate, no spam.\n\nContinue?');
    if (ok) localStorage.setItem(key, '1');
    return ok;
  };

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    setStatus('');
    const body = (input?.value || '').trim();
    if (!body) return;

    if (!ensureAck()) return;

    if (demoMode) {
      toast('Demo: comment added (not saved)');
      input.value = '';
      autosize();
      updateSubmit();
      clearReply();
      return;
    }

    const user = await getUser();
    if (!user) {
      const next = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = `/auth/login.html?next=${next}`;
      return;
    }

    submit.disabled = true;
    setStatus('Posting…');

    try {
      const { error } = await sb.from('post_comments').insert({
        post_id: postId,
        user_id: user.id,
        parent_id: replyTo,
        body,
      });
      if (error) throw error;

      input.value = '';
      autosize();
      updateSubmit();
      clearReply();
      setStatus('Posted');
      setTimeout(() => setStatus(''), 1200);

      document.dispatchEvent(new CustomEvent('ndyra:comments:refresh'));
    } catch (err) {
      console.error(err);
      setStatus(err?.message || 'Failed to post');
      updateSubmit();
    }
  });

  // login link should preserve next
  if (loginLink && !demoMode) {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    loginLink.href = `/auth/login.html?next=${next}`;
  }

  return { setReply, setLoggedIn: (loggedIn) => {
    if (demoMode) return;
    if (form) form.hidden = !loggedIn;
    if (loginBox) loginBox.hidden = !!loggedIn;
    if (composer) composer.hidden = false;
  } };
}

export async function init() {
  const demoMode = qbool('demo') || qs('src') === 'demo';
  markActiveNav('post');

  const sb = await getSupabase();
  const status = document.querySelector('[data-post-status]');

  let id = pathPostId();
  if (!id && demoMode) {
    try {
      const posts = await getDemoPosts();
      id = posts?.[0]?.id || null;
    } catch {
      // ignore
    }
  }

  if (!id) {
    if (status) status.textContent = 'Missing id';
    const box = document.querySelector('[data-post]');
    if (box) box.innerHTML = '<div class="post-card" style="padding:16px;">Missing post id.</div>';
    return;
  }

  if (status) status.textContent = 'Loading…';

  const user = demoMode ? null : await getUser();

  // detail query
  let row;
  try {
    if (demoMode) {
      const posts = await getDemoPosts();
      row = posts.find((p) => p.id === id) || posts[0];
      if (!row) throw new Error('Demo post not found');
      // normalize shape to match live query
      row = {
        id: row.id,
        content_text: row.content_text,
        created_at: row.created_at,
        author_user_id: row.author_user_id,
        visibility: row.visibility,
        post_media: row.media_url ? [{ storage_path: null, media_type: row.media_type, resolvedUrl: row.media_url }] : [],
        post_stats: [{ like_count: row.stats?.like_count || 0, fire_count: row.stats?.fire_count || 0, sweat_count: row.stats?.sweat_count || 0, clap_count: row.stats?.clap_count || 0, comment_count: row.stats?.comment_count || 0 }],
        viewer_reaction: row.viewer_reaction || null,
      };
    } else {
      const { data, error } = await sb
        .from('posts')
        .select(`
          id, content_text, created_at, author_user_id, author_tenant_id, visibility,
          post_media:post_media ( storage_path, media_type, sort_order ),
          post_stats:post_stats ( like_count, fire_count, sweat_count, clap_count, comment_count ),
          viewer_reaction:post_reactions ( reaction )
        `)
        .eq('id', id)
        .maybeSingle();

      if (error) throw error;
      if (!data) throw new Error('Post not found');
      row = data;
    }
  } catch (err) {
    console.error(err);
    if (status) status.textContent = 'Not found';
    const box = document.querySelector('[data-post]');
    if (box) box.innerHTML = `<div class="post-card" style="padding:16px;">${err?.message || 'Post unavailable'}</div>`;
    return;
  }

  // normalize viewer_reaction
  const hydrated = {
    ...row,
    viewer_reaction: row.viewer_reaction?.[0]?.reaction || row.viewer_reaction || null,
    post_stats: row.post_stats?.[0] || row.post_stats || { like_count: 0, fire_count: 0, sweat_count: 0, clap_count: 0, comment_count: 0 },
    post_media: Array.isArray(row.post_media) ? row.post_media.slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)) : [],
  };

  // media url resolve (first media only for now)
  if (!demoMode && hydrated.post_media?.length) {
    for (const m of hydrated.post_media) {
      if (!m.storage_path) continue;
      // bucket assumed
      try {
        // Prefer signed URL (works with private buckets and policies)
        const { data } = await sb.storage.from('post-media').createSignedUrl(m.storage_path, 60 * 30);
        if (data?.signedUrl) m.resolvedUrl = data.signedUrl;
      } catch {
        // ignore
      }
    }
  }

  if (status) status.textContent = demoMode ? 'Demo' : 'Ready';

  const container = document.querySelector('[data-post]');
  const onReactHandler = async (postId, nextType) => {
    // demo: optimistic only
    if (demoMode) {
      hydrated.post_stats = bumpStats(hydrated.post_stats, hydrated.viewer_reaction, nextType);
      hydrated.viewer_reaction = nextType;
      renderPostCard({ container, post: hydrated, user, canReact: true, onReact: onReactHandler });
      return;
    }

    if (!user) return;

    const { error } = await sb
      .from('post_reactions')
      .upsert({ post_id: postId, user_id: user.id, reaction: nextType }, { onConflict: 'post_id,user_id' });
    if (error) throw error;

    hydrated.post_stats = bumpStats(hydrated.post_stats, hydrated.viewer_reaction, nextType);
    hydrated.viewer_reaction = nextType;

    // re-render just the post card (keeps comments below)
    renderPostCard({ container, post: hydrated, user, canReact: true, onReact: onReactHandler });
  };

  renderPostCard({
    container,
    post: hydrated,
    user,
    canReact: Boolean(user) || demoMode,
    onReact: onReactHandler,
  });

  // Comments
  const listEl = document.querySelector('[data-comment-list]');
  const emptyEl = document.querySelector('[data-comment-empty]');
  const countEl = document.querySelector('[data-comment-count]');
  const errEl = document.querySelector('[data-comment-error]');

  const composerApi = setupComposer({ sb, postId: hydrated.id, demoMode });
  composerApi?.setLoggedIn(Boolean(user) || demoMode);

  const refresh = async () => {
    if (!listEl) return;
    if (errEl) {
      errEl.hidden = true;
      errEl.textContent = '';
    }

    try {
      const comments = await fetchComments({ sb, postId: hydrated.id, demoMode });
      renderComments({
        listEl,
        emptyEl,
        countEl,
        comments,
        onReply: ({ id, who }) => composerApi?.setReply({ id, who }),
      });
    } catch (err) {
      console.error(err);
      if (errEl) {
        errEl.hidden = false;
        errEl.textContent = err?.message || 'Failed to load comments';
      }
    }
  };

  document.addEventListener('ndyra:comments:refresh', refresh);
  await refresh();
}

// shared helper (local-only)
function bumpStats(stats, prevReaction, nextReaction) {
  const clone = { ...stats };
  const map = {
    like: 'like_count',
    fire: 'fire_count',
    sweat: 'sweat_count',
    clap: 'clap_count',
  };

  if (prevReaction && map[prevReaction]) {
    clone[map[prevReaction]] = Math.max(0, (clone[map[prevReaction]] || 0) - 1);
  }
  if (nextReaction && map[nextReaction]) {
    clone[map[nextReaction]] = (clone[map[nextReaction]] || 0) + 1;
  }
  return clone;
}

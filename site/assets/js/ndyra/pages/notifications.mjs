import { requireAuth, getSupabase } from '../lib/supabase.mjs';
import { makeEl, toast, formatTimeAgo } from '../lib/utils.mjs';

const PAGE_SIZE = 30;

function qs(sel, root=document){ return root.querySelector(sel); }
function qsa(sel, root=document){ return Array.from(root.querySelectorAll(sel)); }

function isDemoMode(){
  return new URLSearchParams(location.search).get('src') === 'demo';
}

function iconFor(type){
  const t = String(type || '').toLowerCase();
  if(t.includes('reaction')) return '❤️';
  if(t.includes('comment')) return '💬';
  if(t.includes('follow')) return '➕';
  if(t.includes('mention')) return '@';
  return '🔔';
}

function labelFor(n){
  const t = String(n?.type || '').toLowerCase();
  const payload = n?.payload || {};

  if(t === 'reaction'){
    const r = payload?.reaction_type || 'reaction';
    return `Someone reacted (${r}) to your post`;
  }

  if(t === 'comment') return 'New comment on your post';
  if(t === 'follow') return 'New follower';

  return n?.type ? `Notification: ${n.type}` : 'Notification';
}

function buildLink(n){
  if(n?.target_post_id) return `/app/post/?id=${encodeURIComponent(n.target_post_id)}`;
  return '/app/profile/';
}

function renderNotif(n){
  const read = Boolean(n?.read_at);

  const card = makeEl('div', { className: `notif-card ${read ? 'read' : 'unread'}` });
  card.dataset.notifId = n?.id || '';

  const left = makeEl('div', { className:'notif-icon', ariaHidden:'true' }, [iconFor(n?.type)]);
  const main = makeEl('div', { className:'notif-main' });

  const title = makeEl('a', { className:'notif-title', href: buildLink(n) }, [labelFor(n)]);
  const meta = makeEl('div', { className:'notif-meta muted' }, [
    n?.created_at ? formatTimeAgo(n.created_at) : '—',
    read ? ' • Read' : ' • Unread',
  ]);

  main.appendChild(title);
  main.appendChild(meta);

  const actions = makeEl('div', { className:'notif-actions' });

  if(!read){
    const btn = makeEl('button', { className:'btn outline', type:'button' }, ['Mark read']);
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      card.dispatchEvent(new CustomEvent('ndyra:markread', { bubbles:true, detail:{ id:n.id } }));
    });
    actions.appendChild(btn);
  }

  card.appendChild(left);
  card.appendChild(main);
  card.appendChild(actions);

  return card;
}

function demoNotifications(){
  const now = Date.now();
  return [
    { id:'demo-n-1', recipient_user_id:'demo', type:'reaction', target_post_id:'demo-post-1', payload:{ reaction_type:'fire' }, created_at: new Date(now-1000*60*7).toISOString(), read_at:null },
    { id:'demo-n-2', recipient_user_id:'demo', type:'comment', target_post_id:'demo-post-2', payload:{}, created_at: new Date(now-1000*60*22).toISOString(), read_at:null },
    { id:'demo-n-3', recipient_user_id:'demo', type:'follow', actor_user_id:'demo-user-b', payload:{}, created_at: new Date(now-1000*60*90).toISOString(), read_at: new Date(now-1000*60*30).toISOString() },
  ];
}

export async function init(){
  const demo = isDemoMode();

  const status = qs('[data-notifs-status]');
  const list = qs('[data-notifs-list]');
  const refreshBtn = qs('[data-notifs-refresh]');
  const markAllBtn = qs('[data-notifs-markall]');
  const loadMoreBtn = qs('[data-notifs-loadmore]');

  let user = null;
  let supabase = null;

  if(!demo){
    user = await requireAuth({ next: location.pathname + location.search });
    if(!user) return;
    supabase = getSupabase();
  }

  let cursor = null;
  let loaded = 0;

  function setStatus(t){ if(status) status.textContent = t; }
  function clear(){ if(list) list.innerHTML = ''; loaded = 0; cursor = null; }

  async function fetchBatch(){
    if(demo){
      return demoNotifications();
    }

    let q = supabase
      .from('notifications')
      .select('*')
      .eq('recipient_user_id', user.id)
      .order('created_at', { ascending:false })
      .limit(PAGE_SIZE);

    if(cursor) q = q.lt('created_at', cursor);

    const { data, error } = await q;
    if(error) throw error;
    return data || [];
  }

  async function renderMore(){
    setStatus('Loading…');

    try {
      const batch = await fetchBatch();

      if(!batch.length){
        if(!loaded) setStatus('No notifications yet.');
        else setStatus(`${loaded} loaded`);
        if(loadMoreBtn) loadMoreBtn.hidden = true;
        return;
      }

      for(const n of batch){
        const card = renderNotif(n);
        list?.appendChild(card);
        loaded++;
        cursor = n.created_at;
      }

      setStatus(`${loaded} loaded`);

      if(loadMoreBtn){
        loadMoreBtn.hidden = demo ? true : batch.length < PAGE_SIZE;
      }

    } catch (e) {
      console.warn('[NDYRA] notifications load failed', e);
      setStatus('Could not load notifications. Check Supabase + RLS.');
      if(loadMoreBtn) loadMoreBtn.hidden = true;
    }
  }

  // Mark read handler
  document.addEventListener('ndyra:markread', async (e) => {
    const id = e?.detail?.id;
    if(!id) return;

    if(demo){
      toast('Demo mode: cannot mark read');
      return;
    }

    try {
      const { error } = await supabase
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .eq('id', id)
        .eq('recipient_user_id', user.id);

      if(error) throw error;

      // Optimistic UI
      const card = qs(`.notif-card[data-notif-id="${id}"]`);
      if(card){
        card.classList.remove('unread');
        card.classList.add('read');
        const btn = card.querySelector('.notif-actions .btn');
        btn?.remove?.();
        const meta = card.querySelector('.notif-meta');
        if(meta && !meta.textContent.includes('Read')) meta.textContent += ' • Read';
      }
    } catch (err) {
      console.warn('[NDYRA] mark read failed', err);
      toast('Could not mark read');
    }
  });

  async function refresh(){
    clear();
    await renderMore();
  }

  if(refreshBtn) refreshBtn.addEventListener('click', refresh);
  if(loadMoreBtn) loadMoreBtn.addEventListener('click', renderMore);

  if(markAllBtn){
    markAllBtn.addEventListener('click', async () => {
      if(demo){
        toast('Demo mode: cannot mark all read');
        return;
      }

      try {
        const { error } = await supabase
          .from('notifications')
          .update({ read_at: new Date().toISOString() })
          .eq('recipient_user_id', user.id)
          .is('read_at', null);

        if(error) throw error;

        toast('All marked read');
        await refresh();
      } catch (e) {
        console.warn('[NDYRA] mark all read failed', e);
        toast('Could not mark all read');
      }
    });
  }

  await renderMore();
}

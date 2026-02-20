import { makeEl, formatTimeAgo, safeText } from '../lib/utils.mjs';
import { renderReactionBar, applyReactionCounts, applyReactionState } from './reactionBar.mjs';

const AVATAR_FALLBACK = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='96' height='96'%3E%3Crect width='96' height='96' rx='24' fill='%23141522'/%3E%3Cpath d='M48 50c10 0 18-8 18-18S58 14 48 14 30 22 30 32s8 18 18 18zm0 10c-18 0-32 10-32 22v6h64v-6c0-12-14-22-32-22z' fill='%237C7F92'/%3E%3C/svg%3E`;

function pickPrimaryMedia(post){
  const m = (post.post_media && post.post_media[0]) ? post.post_media[0] : null;
  if(!m) return null;
  // demo data can include public_url
  if(m.public_url) return { ...m, resolvedUrl: m.public_url };
  return m;
}

export function renderPostCard({ post, author=null, tenant=null, viewerReaction=null, canReact=false, onReact=null, onHide=null }){
  const card = makeEl('article', { class:'post-card', 'data-post-id': post.id });

  const name = author?.full_name || author?.display_name || author?.handle || tenant?.name || 'Unknown';
  const handle = author?.handle ? '@' + author.handle : (tenant?.slug ? '@' + tenant.slug : '');
  const avatar = author?.avatar_url || tenant?.avatar_url || AVATAR_FALLBACK;

  const head = makeEl('div', { class:'post-head' });

  const left = makeEl('div', { class:'post-author' }, [
    makeEl('img', { src: avatar, alt: safeText(name), loading:'lazy' }),
    makeEl('div', { class:'meta' }, [
      makeEl('div', { class:'name', text: safeText(name) }),
      makeEl('div', { class:'sub', text: `${handle} • ${formatTimeAgo(post.created_at)}`.trim() }),
    ])
  ]);

  const menu = makeEl('div', { class:'post-menu' });
  const btnHide = makeEl('button', { type:'button', text:'Not interested' });
  btnHide.addEventListener('click', () => {
    if(typeof onHide === 'function') onHide(post.id);
  });
  menu.appendChild(btnHide);

  head.appendChild(left);
  head.appendChild(menu);

  // Media
  const mediaWrap = makeEl('div', { class:'post-media' });
  const media = pickPrimaryMedia(post);
  if(media && (media.resolvedUrl || media.storage_path)){
    // We'll set src later if unresolved (page module can patch in)
    if(media.media_type === 'video'){
      const v = makeEl('video', { playsInline:true, muted:true, loop:true, preload:'metadata' });
      if(media.resolvedUrl) v.src = media.resolvedUrl;
      v.setAttribute('data-media-path', safeText(media.storage_path || ''));
      mediaWrap.appendChild(v);
    }else{
      const img = makeEl('img', { alt: 'Post media', loading:'lazy' });
      if(media.resolvedUrl) img.src = media.resolvedUrl;
      img.setAttribute('data-media-path', safeText(media.storage_path || ''));
      mediaWrap.appendChild(img);
    }
  }else{
    mediaWrap.appendChild(makeEl('div', { class:'post-caption', text:'(no media yet)' }));
  }

  const body = makeEl('div', { class:'post-body' });
  const caption = makeEl('div', { class:'post-caption', text: safeText(post.content_text) });

  const statsRow = (post.post_stats && post.post_stats[0]) ? post.post_stats[0] : post.post_stats;
  const reactionBar = renderReactionBar({
    postId: post.id,
    stats: statsRow,
    activeReaction: viewerReaction,
    canReact,
    onReact: async (reactionKey) => {
      if(typeof onReact === 'function'){
        await onReact(post.id, reactionKey, { card, reactionBarRoot: reactionBar });
      }
    }
  });

  const actions = makeEl('div', { class:'post-actions' }, [
    makeEl('a', { href: `/app/post/${post.id}`, text: `Comments (${(statsRow?.comments_count ?? 0)})` })
  ]);

  body.appendChild(caption);
  body.appendChild(reactionBar);
  body.appendChild(actions);

  card.appendChild(head);
  card.appendChild(mediaWrap);
  card.appendChild(body);

  // Expose tiny helpers for page module
  card.__ndyra = {
    setCounts: (nextStats) => applyReactionCounts(reactionBar, nextStats),
    setActive: (k) => applyReactionState(reactionBar, k),
  };

  return card;
}

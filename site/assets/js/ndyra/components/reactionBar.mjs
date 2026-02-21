import { makeEl } from '../lib/utils.mjs';

const REACTIONS = [
  { key:'fire',  label:'Fire',  icon:'🔥' },
  { key:'flex',  label:'Flex',  icon:'💪' },
  { key:'heart', label:'Energy', icon:'⚡' },
  { key:'clap',  label:'Clap',  icon:'👏' },
  { key:'check', label:'Brain', icon:'🧠' },
];

function countFor(stats, key){
  if(!stats) return 0;
  const map = {
    fire:  stats.reactions_fire,
    flex:  stats.reactions_flex,
    heart: stats.reactions_heart,
    clap:  stats.reactions_clap,
    check: stats.reactions_check,
  };
  const v = map[key];
  return (v === null || v === undefined) ? 0 : Number(v);
}

export function renderReactionBar({ postId, stats, activeReaction=null, canReact=false, onReact=null }){
  const wrap = makeEl('div', { class:'reaction-bar', 'data-post-id': postId });

  const left = makeEl('div', { class:'reactions' });
  for(const r of REACTIONS){
    const btn = makeEl('button', {
      class: `react-btn${activeReaction === r.key ? ' active':''}`,
      type:'button',
      'data-reaction': r.key,
      title: canReact ? `React: ${r.label}` : 'Log in to react',
      disabled: !canReact
    }, [
      makeEl('span', { class:'ico', text: r.icon }),
      makeEl('span', { class:'count', text: String(countFor(stats, r.key)) }),
    ]);
    btn.addEventListener('click', async () => {
      if(!canReact) return;
      if(typeof onReact === 'function'){
        await onReact(r.key);
      }
    });
    left.appendChild(btn);
  }

  wrap.appendChild(left);
  return wrap;
}

export function applyReactionState(rootEl, reactionKey){
  const btns = rootEl.querySelectorAll('.react-btn');
  btns.forEach(b => {
    const k = b.getAttribute('data-reaction');
    if(k === reactionKey) b.classList.add('active');
    else b.classList.remove('active');
  });
}

export function applyReactionCounts(rootEl, stats){
  const btns = rootEl.querySelectorAll('.react-btn');
  btns.forEach(b => {
    const k = b.getAttribute('data-reaction');
    const c = b.querySelector('.count');
    if(!c) return;
    c.textContent = String(countFor(stats, k));
  });
}

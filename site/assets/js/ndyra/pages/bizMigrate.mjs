const STEPS = [
  { href: '/biz/migrate/', label: 'Start' },
  { href: '/biz/migrate/members/', label: 'Members' },
  { href: '/biz/migrate/schedule/', label: 'Schedule' },
  { href: '/biz/migrate/verify/', label: 'Verify' },
  { href: '/biz/migrate/commit/', label: 'Commit' },
  { href: '/biz/migrate/cutover/', label: 'Cutover' },
];

function normalizePath(p){
  if(!p) return '/';
  return p.endsWith('/') ? p : p + '/';
}

function currentStep(){
  const here = normalizePath(window.location.pathname || '/');
  // find the longest matching href
  let best = STEPS[0];
  for(const s of STEPS){
    const h = normalizePath(s.href);
    if(here.startsWith(h) && h.length >= normalizePath(best.href).length){
      best = s;
    }
  }
  return best;
}

function render(){
  const mount = document.querySelector('[data-migrate-ui]');
  if(!mount) return;

  const active = currentStep();

  const nav = document.createElement('div');
  nav.style.display = 'flex';
  nav.style.flexWrap = 'wrap';
  nav.style.gap = '10px';
  nav.style.marginBottom = '12px';

  for(const s of STEPS){
    const a = document.createElement('a');
    a.href = s.href;
    a.textContent = s.label;
    a.style.padding = '6px 10px';
    a.style.borderRadius = '999px';
    a.style.border = '1px solid rgba(255,255,255,0.18)';
    a.style.textDecoration = 'none';
    a.style.opacity = (s.href === active.href) ? '1' : '0.65';
    nav.appendChild(a);
  }

  const body = document.createElement('div');
  body.innerHTML = `
    <div style="display:flex; gap:10px; align-items: baseline; flex-wrap: wrap;">
      <strong>Current step:</strong>
      <span style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;">${active.label}</span>
    </div>
    <p style="margin: 10px 0 0; opacity: .85;">Scaffold only. This flow will import legacy data, validate it, and then atomically switch <code>tenants.system_of_record</code> on commit/cutover (Blueprint v7.3.1).</p>
  `;

  mount.innerHTML = '';
  mount.appendChild(nav);
  mount.appendChild(body);
}

export async function init(){
  render();
}

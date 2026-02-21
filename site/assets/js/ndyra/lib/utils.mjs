export function qs(name){
  return new URLSearchParams(window.location.search).get(name);
}

export function qbool(name){
  const v = qs(name);
  if(v === null) return false;
  if(v === '' ) return true;
  return ['1','true','yes','y','on'].includes(String(v).toLowerCase());
}

export function sleep(ms){
  return new Promise(r => setTimeout(r, ms));
}

export function formatTimeAgo(iso){
  try{
    const d = new Date(iso);
    const sec = Math.floor((Date.now() - d.getTime())/1000);
    if(sec < 10) return 'just now';
    if(sec < 60) return sec + 's';
    const min = Math.floor(sec/60);
    if(min < 60) return min + 'm';
    const hr = Math.floor(min/60);
    if(hr < 24) return hr + 'h';
    const day = Math.floor(hr/24);
    if(day < 7) return day + 'd';
    return d.toLocaleDateString();
  }catch(_){
    return '';
  }
}

export function makeEl(tag, attrs={}, children=[]){
  const el = document.createElement(tag);
  for(const [k,v] of Object.entries(attrs)){
    if(v === null || v === undefined) continue;
    if(k === 'class') el.className = v;
    else if(k === 'text') el.textContent = v;
    else if(k.startsWith('data-')) el.setAttribute(k, v);
    else if(k === 'html') el.innerHTML = v;
    else if(k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  for(const ch of children){
    if(ch === null || ch === undefined) continue;
    if(typeof ch === 'string') el.appendChild(document.createTextNode(ch));
    else el.appendChild(ch);
  }
  return el;
}

export function safeText(v){
  return (v === null || v === undefined) ? '' : String(v);
}


export function markActiveNav(key) {
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const match = a.getAttribute('data-nav') === key;
    a.classList.toggle('active', match);
  });
}

let __toastEl;
let __toastTimer;

export function toast(message, opts = {}) {
  const msg = String(message || '').trim();
  if (!msg) return;

  const duration = Number(opts.duration || 2200);

  if (!__toastEl) {
    __toastEl = document.createElement('div');
    __toastEl.className = 'ndyra-toast';
    __toastEl.setAttribute('role', 'status');
    __toastEl.setAttribute('aria-live', 'polite');
    document.body.appendChild(__toastEl);
  }

  __toastEl.textContent = msg;
  __toastEl.classList.add('show');

  if (__toastTimer) window.clearTimeout(__toastTimer);
  __toastTimer = window.setTimeout(() => {
    __toastEl?.classList.remove('show');
  }, duration);
}

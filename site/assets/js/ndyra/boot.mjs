async function loadBuild(){
  try{
    const r = await fetch('/assets/build.json', { cache:'no-store' });
    if(!r.ok) return null;
    return await r.json();
  }catch(_){
    return null;
  }
}

function applyBuildLabel(label){
  if(!label) return;
  try{
    document.querySelectorAll('.footer').forEach(f=>{
      f.innerHTML = f.innerHTML.replace(/build preview \(CP\d+\)/g, `build preview (${label})`);
    });
    document.querySelectorAll('[data-build-label]').forEach(el=>{
      el.textContent = label;
    });
  }catch(_){}
}

async function boot(){
  document.body.classList.add('ndyra');

  const build = await loadBuild();
  if(build?.label) applyBuildLabel(build.label);

  const page = document.body?.dataset?.page || '';
  const map = {
    'ndyra-fyp': './pages/fyp.mjs',
    'ndyra-following': './pages/following.mjs',
    'ndyra-create': './pages/create.mjs',
    'ndyra-notifications': './pages/notifications.mjs',
    'ndyra-profile': './pages/profile.mjs',
    'ndyra-post': './pages/post.mjs',

  // Blueprint v7.3.1 route scaffolds
  'ndyra-gym-join': './pages/gym_join.mjs',
  'ndyra-book-class': './pages/book_class.mjs',
  'ndyra-biz-checkin': './pages/biz_checkin.mjs',
  'ndyra-biz-migrate': './pages/biz_migrate.mjs',
  };

  const modPath = map[page];
  if(!modPath) return;

  try{
    const mod = await import(modPath);
    if(typeof mod.init === 'function'){
      await mod.init();
    }
  }catch(err){
    console.error('[NDYRA] boot failed', err);
    const s = document.querySelector('[data-ndyra-status]');
    if(s) s.textContent = 'Something went wrong loading this page.';
  }
}

boot();

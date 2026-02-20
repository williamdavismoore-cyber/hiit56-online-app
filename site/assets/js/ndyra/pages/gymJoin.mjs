function pathGymSlug(){
  const parts = (window.location.pathname || '').split('/').filter(Boolean);
  // Expected: /gym/{slug}/join
  if(parts.length >= 3 && parts[0] === 'gym' && parts[2] === 'join') return parts[1];

  // If served from /gym/join/ (fallback)
  const slug = new URLSearchParams(window.location.search).get('slug');
  return slug;
}

export async function init(){
  const slug = pathGymSlug();
  const el = document.querySelector('[data-gym-slug]');
  if(el) el.textContent = slug || '(unknown)';
}

import { safeText } from '../lib/utils.mjs';

function getGymSlugFromPath(pathname) {
  // Expected public route: /gym/{slug}/join
  const m = (pathname || '').match(/^\/gym\/([^/]+)\/join\/?$/i);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
}

export function init() {
  const slug = getGymSlugFromPath(window.location.pathname) || 'demo-gym';
  const slugEl = document.getElementById('gymSlug');
  safeText(slugEl, slug);

  const btn = document.getElementById('joinContinue');
  if (btn) {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      // Placeholder until we wire account → waiver → payment → confirm.
      alert('Quick Join scaffold — next step wiring lands next.');
    });
  }
}

import { safeText } from '../lib/utils.mjs';

function getClassIdFromPath(pathname) {
  // Expected route: /app/book/class/{class_id}
  const m = (pathname || '').match(/^\/app\/book\/class\/([^/]+)\/?$/i);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
}

export function init() {
  const classId = getClassIdFromPath(window.location.pathname) || 'demo-class';
  const el = document.getElementById('classId');
  safeText(el, classId);

  const btn = document.getElementById('bookContinue');
  if (btn) {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      alert('Booking scaffold — rules + payment gates land next.');
    });
  }
}

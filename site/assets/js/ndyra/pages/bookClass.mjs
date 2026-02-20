function pathClassSessionId(){
  const parts = (window.location.pathname || '').split('/').filter(Boolean);
  // Expected: /app/book/class/{class_session_id}
  if(parts.length >= 4 && parts[0] === 'app' && parts[1] === 'book' && parts[2] === 'class') return parts[3];

  // Fallback: allow ?class_session_id=
  const qs = new URLSearchParams(window.location.search);
  return qs.get('class_session_id') || qs.get('id');
}

export async function init(){
  const id = pathClassSessionId();
  const el = document.querySelector('[data-class-session-id]');
  if(el) el.textContent = id || '(unknown)';
}

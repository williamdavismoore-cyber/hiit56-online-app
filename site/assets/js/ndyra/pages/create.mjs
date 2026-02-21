import { qs, qbool, toast, markActiveNav } from '../lib/utils.mjs';
import { getSupabase, requireAuth, getUser } from '../lib/supabase.mjs';

function sanitizeFileName(name = '') {
  return (name || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/-+/g, '-')
    .slice(0, 80) || 'upload';
}

function isVideo(file) {
  return (file?.type || '').startsWith('video/');
}

function renderPreviews(previewsEl, files, onRemove) {
  if (!previewsEl) return;
  previewsEl.innerHTML = '';

  files.forEach((file, idx) => {
    const url = URL.createObjectURL(file);

    const wrap = document.createElement('div');
    wrap.className = 'create-media-item';
    wrap.dataset.index = String(idx);

    const thumb = document.createElement('div');
    thumb.className = 'create-thumb';

    if (isVideo(file)) {
      const v = document.createElement('video');
      v.src = url;
      v.muted = true;
      v.playsInline = true;
      v.loop = true;
      v.autoplay = true;
      thumb.appendChild(v);
    } else {
      const img = document.createElement('img');
      img.src = url;
      img.alt = file.name || 'selected media';
      thumb.appendChild(img);
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pill-x';
    btn.setAttribute('aria-label', 'Remove media');
    btn.textContent = '×';
    btn.addEventListener('click', () => {
      URL.revokeObjectURL(url);
      onRemove(idx);
    });

    wrap.appendChild(thumb);
    wrap.appendChild(btn);
    previewsEl.appendChild(wrap);
  });
}

export async function init() {
  const demoMode = qbool('demo') || qs('src') === 'demo';
  markActiveNav('create');

  const sb = await getSupabase();
  const status = document.querySelector('[data-create-status]');
  const form = document.querySelector('[data-create-form]');
  if (!form) return;

  const textEl = form.querySelector('[data-create-text]');
  const filesEl = form.querySelector('[data-create-files]');
  const previewsEl = form.querySelector('[data-create-previews]');
  const submitBtn = form.querySelector('[data-create-submit]');
  const errorEl = form.querySelector('[data-create-error]');
  const visibilityEl = form.querySelector('[data-create-visibility]');

  let files = [];
  let posting = false;

  // Auth gate (real mode)
  if (!demoMode) {
    if (status) status.textContent = 'Auth…';
    const u = await requireAuth();
    if (!u) return; // requireAuth will redirect
    if (status) status.textContent = 'Ready';
  } else {
    if (status) status.textContent = 'Demo';
  }

  const setError = (msg) => {
    if (!errorEl) return;
    errorEl.hidden = !msg;
    errorEl.textContent = msg || '';
  };

  const autosize = () => {
    if (!textEl) return;
    textEl.style.height = 'auto';
    textEl.style.height = Math.min(textEl.scrollHeight, 240) + 'px';
  };

  const updateSubmit = () => {
    const hasText = ((textEl?.value || '').trim().length > 0);
    const hasFiles = files.length > 0;
    const ok = hasText || hasFiles;
    if (submitBtn) submitBtn.disabled = posting || !ok;
  };

  const rerender = () => renderPreviews(previewsEl, files, removeAt);

  const removeAt = (idx) => {
    files = files.filter((_, i) => i !== idx);
    rerender();
    updateSubmit();
  };

  textEl?.addEventListener('input', () => {
    autosize();
    updateSubmit();
  });

  filesEl?.addEventListener('change', () => {
    setError('');
    const next = Array.from(filesEl.files || []);
    files = next.slice(0, 10);
    if (next.length > 10) toast('Limit: 10 files max');
    rerender();
    updateSubmit();
  });

  autosize();
  updateSubmit();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (posting) return;

    setError('');
    const content = (textEl?.value || '').trim();
    const visibility = visibilityEl?.value || 'public';

    if (!content && files.length === 0) {
      setError('Add text or media first.');
      return;
    }

    posting = true;
    updateSubmit();
    if (status) status.textContent = 'Posting…';

    try {
      if (demoMode) {
        toast('Demo: post created (not saved)');
        window.location.href = '/app/fyp/?src=demo';
        return;
      }

      const user = await getUser();
      if (!user) {
        const next = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.href = `/auth/login.html?next=${next}`;
        return;
      }

      // 1) create post row
      const { data: post, error: postErr } = await sb
        .from('posts')
        .insert({
          author_user_id: user.id,
          content_text: content || null,
          visibility,
        })
        .select('id')
        .single();

      if (postErr) throw postErr;

      // 2) upload media (optional)
      if (files.length > 0) {
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const safe = sanitizeFileName(file.name || `media-${i}`);
          const path = `posts/${post.id}/${String(i).padStart(2, '0')}_${Date.now()}_${safe}`;

          const { error: upErr } = await sb.storage
            .from('post-media')
            .upload(path, file, { upsert: false, contentType: file.type || undefined });

          if (upErr) throw upErr;

          const media_type = isVideo(file) ? 'video' : 'image';

          const { error: pmErr } = await sb
            .from('post_media')
            .insert({
              post_id: post.id,
              storage_path: path,
              media_type,
              sort_order: i,
            });

          if (pmErr) throw pmErr;
        }
      }

      toast('Posted');
      window.location.href = `/app/post/${post.id}`;
    } catch (err) {
      console.error(err);
      setError(err?.message || String(err));
      if (status) status.textContent = 'Error';
    } finally {
      posting = false;
      updateSubmit();
      if (status && status.textContent === 'Posting…') status.textContent = 'Ready';
    }
  });
}

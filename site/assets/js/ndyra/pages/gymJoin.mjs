import { ensureProfile, getSupabase } from '../lib/supabase.mjs';
import { qbool, qs } from '../lib/utils.mjs';
import { toast } from '../components/toast.mjs';
import { createSignaturePad } from '../components/signaturePad.mjs';

const demoMode = qbool('src', 'demo');

const STEPS = ['account', 'waiver', 'payment', 'done'];

function pathGymSlug() {
  // Matches /gym/{slug}/join
  const m = (location.pathname || '').match(/^\/gym\/([^/]+)\/join\/?$/i);
  return m ? decodeURIComponent(m[1]) : null;
}

function stepFromUrl() {
  const s = (qs('step') || '').toLowerCase();
  return STEPS.includes(s) ? s : 'account';
}

function setStep(step) {
  const url = new URL(location.href);
  url.searchParams.set('step', step);
  history.replaceState({}, '', url.toString());
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) node.appendChild(c);
  return node;
}

function renderSteps(current) {
  const wrap = el('div', { class: 'join-steps' });
  for (const s of STEPS) {
    const pill = el('div', {
      class: 'join-step' + (s === current ? ' active' : ''),
      text: s === 'done' ? 'confirmation' : s
    });
    wrap.appendChild(pill);
  }
  return wrap;
}

async function getSession(sb) {
  const { data } = await sb.auth.getSession();
  return data?.session || null;
}

async function signInOrUp(sb, mode, email, password) {
  if (mode === 'signup') {
    return sb.auth.signUp({ email, password });
  }
  return sb.auth.signInWithPassword({ email, password });
}

async function resolveTenant(sb, slug) {
  if (demoMode) {
    return {
      id: '00000000-0000-0000-0000-000000000000',
      slug: slug || 'demo-gym',
      name: 'Demo Gym',
      active_waiver_version: 1,
      waiver: {
        title: 'Demo Waiver (Sample)',
        body_md: 'This is demo text. In real mode, your gym’s waiver template will load from Supabase.\n\nBy signing below, you agree to participate at your own risk.'
      }
    };
  }

  const { data, error } = await sb
    .from('tenants')
    .select('id, slug, name, active_waiver_version')
    .eq('slug', slug)
    .single();

  if (error) throw error;
  return data;
}

async function resolveActiveWaiverTemplate(sb, tenant) {
  if (demoMode) return tenant.waiver;

  const v = tenant.active_waiver_version;
  if (!v) throw new Error('No active waiver configured for this gym yet.');

  const { data, error } = await sb
    .from('waiver_templates')
    .select('tenant_id, version, title, body_md')
    .eq('tenant_id', tenant.id)
    .eq('version', v)
    .single();

  if (error) throw error;
  return data;
}

export async function init() {
  const root = document.getElementById('join-root');
  if (!root) return;

  const slug = pathGymSlug();
  if (!slug) {
    root.textContent = 'Missing gym slug in URL.';
    return;
  }

  // Force explicit step param for predictability
  if (!qs('step')) setStep('account');

  let sb = null;
  let session = null;
  let tenant = null;
  let waiver = null;

  async function render() {
    const step = stepFromUrl();

    root.innerHTML = '';
    root.appendChild(renderSteps(step));

    if (demoMode) {
      root.appendChild(el('div', { class: 'muted', text: `Demo mode • gym slug: ${slug}` }));
    }

    if (step === 'account') {
      root.appendChild(await renderAccount());
      return;
    }

    // Past this point, account must exist (demo can fake it)
    root.appendChild(await renderGate(step));
  }

  async function ensureSb() {
    if (demoMode) return null;
    sb = sb || await getSupabase();
    return sb;
  }

  async function ensureTenant() {
    if (tenant) return tenant;
    const s = await ensureSb();
    tenant = await resolveTenant(s, slug);
    return tenant;
  }

  async function ensureWaiver() {
    if (waiver) return waiver;
    const s = await ensureSb();
    const t = await ensureTenant();
    waiver = await resolveActiveWaiverTemplate(s, t);
    return waiver;
  }

  async function ensureAuthed() {
    if (demoMode) return { id: '00000000-0000-0000-0000-000000000001', email: 'demo@ndyra.local' };

    const s = await ensureSb();
    session = session || await getSession(s);
    if (!session?.user) return null;

    await ensureProfile(session.user);
    return session.user;
  }

  async function renderAccount() {
    const box = el('div');

    box.appendChild(el('h2', { text: '1) Account' }));
    box.appendChild(el('p', { class: 'muted', text: 'Create an account (or sign in) so your waiver and membership attach to you.' }));

    if (demoMode) {
      box.appendChild(el('p', { class: 'muted', text: 'Demo mode skips real auth.' }));
      const actions = el('div', { class: 'join-actions' });
      const nextBtn = el('button', { class: 'btn primary', text: 'Continue to waiver', onclick: () => { setStep('waiver'); render(); } });
      actions.appendChild(nextBtn);
      box.appendChild(actions);
      return box;
    }

    const s = await ensureSb();
    session = session || await getSession(s);

    if (session?.user) {
      box.appendChild(el('p', { class: 'muted', text: `Signed in as ${session.user.email}` }));
      const actions = el('div', { class: 'join-actions' });
      actions.appendChild(el('button', { class: 'btn primary', text: 'Continue to waiver', onclick: () => { setStep('waiver'); render(); } }));
      actions.appendChild(el('button', { class: 'btn', text: 'Sign out', onclick: async () => { await s.auth.signOut(); session = null; toast('Signed out'); render(); } }));
      box.appendChild(actions);
      return box;
    }

    // Sign up / sign in form
    let mode = 'signup';

    const modeRow = el('div', { class: 'join-actions' });
    const btnSignup = el('button', { class: 'btn primary', text: 'Create account', onclick: () => { mode = 'signup'; btnSignup.classList.add('primary'); btnSignin.classList.remove('primary'); } });
    const btnSignin = el('button', { class: 'btn', text: 'Sign in', onclick: () => { mode = 'signin'; btnSignin.classList.add('primary'); btnSignup.classList.remove('primary'); } });
    modeRow.appendChild(btnSignup);
    modeRow.appendChild(btnSignin);

    const email = el('input', { type: 'email', placeholder: 'Email', style: 'width:100%;margin-top:10px;padding:10px;border-radius:10px;border:1px solid rgba(0,0,0,0.15);' });
    const pass = el('input', { type: 'password', placeholder: 'Password', style: 'width:100%;margin-top:10px;padding:10px;border-radius:10px;border:1px solid rgba(0,0,0,0.15);' });

    const submit = el('button', { class: 'btn primary', text: 'Continue', style: 'margin-top:12px' });

    submit.addEventListener('click', async () => {
      const e = email.value.trim();
      const p = pass.value;
      if (!e || !p) {
        toast('Email + password required');
        return;
      }

      submit.disabled = true;
      submit.textContent = 'Working…';

      try {
        const { data, error } = await signInOrUp(s, mode, e, p);
        if (error) throw error;

        // On signUp, session may be null if email confirmation is required.
        const sess = data?.session || (await getSession(s));
        session = sess;

        if (!session?.user) {
          toast('Check your email to confirm your account, then return here.');
          return;
        }

        await ensureProfile(session.user);
        toast('Signed in');
        setStep('waiver');
        await render();
      } catch (err) {
        toast(err?.message || 'Auth failed');
      } finally {
        submit.disabled = false;
        submit.textContent = 'Continue';
      }
    });

    box.appendChild(modeRow);
    box.appendChild(email);
    box.appendChild(pass);
    box.appendChild(submit);

    return box;
  }

  async function renderGate(step) {
    const user = await ensureAuthed();
    if (!user) {
      const box = el('div');
      box.appendChild(el('h2', { text: 'Sign in required' }));
      box.appendChild(el('p', { class: 'muted', text: 'Please sign in to continue your Quick Join.' }));
      box.appendChild(el('a', { class: 'btn primary', href: `/login.html?next=${encodeURIComponent(location.pathname + location.search)}`, text: 'Go to login' }));
      return box;
    }

    if (step === 'waiver') return await renderWaiver(user);
    if (step === 'payment') return await renderPayment(user);
    if (step === 'done') return await renderDone(user);

    return el('div', { text: 'Unknown step.' });
  }

  async function renderWaiver(user) {
    const box = el('div');
    box.appendChild(el('h2', { text: '2) Waiver' }));

    let t;
    try {
      t = await ensureTenant();
    } catch (err) {
      box.appendChild(el('p', { class: 'muted', text: `Gym not found for slug: ${slug}` }));
      box.appendChild(el('p', { class: 'muted', text: 'If this is your gym, confirm the slug exists in tenants.' }));
      box.appendChild(el('a', { class: 'btn', href: '/', text: 'Back to home' }));
      return box;
    }

    try {
      const tpl = await ensureWaiver();

      const title = tpl?.title || 'Waiver';
      const bodyText = tpl?.body_md || '(No waiver text configured)';

      box.appendChild(el('p', { class: 'muted', text: `Gym: ${t.name || t.slug} • Waiver v${t.active_waiver_version || tpl.version || '?'}` }));
      box.appendChild(el('h3', { text: title }));
      box.appendChild(el('pre', { style: 'white-space:pre-wrap; padding:12px; border-radius:12px; background:rgba(0,0,0,0.06);' , text: bodyText }));

      box.appendChild(el('p', { class: 'muted', text: 'Sign below:' }));

      const sig = createSignaturePad({ width: 720, height: 240 });
      box.appendChild(sig.el);

      const actions = el('div', { class: 'join-actions' });

      const backBtn = el('button', { class: 'btn', text: 'Back', onclick: () => { setStep('account'); render(); } });
      const clearBtn = el('button', { class: 'btn', text: 'Clear', onclick: () => sig.clear() });
      const saveBtn = el('button', { class: 'btn primary', text: demoMode ? 'Continue' : 'Save signature & continue' });

      saveBtn.addEventListener('click', async () => {
        if (demoMode) {
          toast('Demo waiver signed');
          setStep('payment');
          render();
          return;
        }

        saveBtn.disabled = true;
        saveBtn.textContent = 'Uploading…';

        try {
          const sb2 = await ensureSb();
          const blob = await sig.toBlob();
          if (!blob) throw new Error('Could not export signature image');

          const version = t.active_waiver_version;
          if (!version) throw new Error('Gym waiver not configured (missing active_waiver_version)');

          const fileId = crypto.randomUUID();
          const key = `t/${t.id}/u/${user.id}/v${version}/${fileId}.png`;

          const { error: upErr } = await sb2.storage
            .from('waiver-signatures')
            .upload(key, blob, { contentType: 'image/png', upsert: false });

          if (upErr) throw upErr;

          // Record in DB via RPC
          const { data: rpcData, error: rpcErr } = await sb2.rpc('sign_current_waiver', {
            p_tenant_id: t.id,
            p_signature_storage_path: key
          });

          if (rpcErr) throw rpcErr;

          toast('Waiver saved');
          // Proceed
          setStep('payment');
          render();
        } catch (err) {
          toast(err?.message || 'Failed to save waiver');
        } finally {
          saveBtn.disabled = false;
          saveBtn.textContent = demoMode ? 'Continue' : 'Save signature & continue';
        }
      });

      actions.appendChild(backBtn);
      actions.appendChild(clearBtn);
      actions.appendChild(saveBtn);

      box.appendChild(actions);
      return box;
    } catch (err) {
      box.appendChild(el('p', { class: 'muted', text: err?.message || 'Unable to load waiver' }));
      box.appendChild(el('p', { class: 'muted', text: 'Staff: use waiver-template-update to create the first template and set tenants.active_waiver_version.' }));
      box.appendChild(el('button', { class: 'btn', text: 'Back', onclick: () => { setStep('account'); render(); } }));
      return box;
    }
  }

  async function renderPayment(user) {
    const box = el('div');
    box.appendChild(el('h2', { text: '3) Payment' }));

    const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    const successPath = `/gym/${encodeURIComponent(slug)}/join?step=done&checkout=success`;
    const cancelPath  = `/gym/${encodeURIComponent(slug)}/join?step=payment&checkout=canceled`;

    box.appendChild(el('p', {
      class: 'muted',
      text: 'If your gym requires payment, you’ll be redirected to checkout. In demo/QA you can also skip payment to verify the whole flow.'
    }));

    if (url.searchParams.get('checkout') === 'canceled') {
      box.appendChild(el('p', { class: 'muted', text: 'Checkout canceled. You can try again.' }));
    }

    const status = el('p', { class: 'muted', text: '' });
    box.appendChild(status);

    const actions = el('div', { class: 'join-actions' });
    actions.appendChild(el('button', {
      class: 'btn',
      text: 'Back',
      onclick: () => { setStep('waiver'); render(); }
    }));

    const checkoutBtn = el('button', {
      class: 'btn primary',
      text: isLocal ? 'Checkout (deploy preview required)' : 'Start checkout',
      onclick: async () => {
        try {
          if (!user?.email) throw new Error('You must be logged in to start checkout.');

          status.textContent = 'Creating checkout session…';
          checkoutBtn.disabled = true;

          const res = await fetch('/.netlify/functions/stripe_create_checkout_session', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              // Reuse existing tier/plan primitives until gym pricing lands.
              tier: 'member',
              plan: 'monthly',
              email: user.email,
              subject_type: 'profile',
              subject_id: user.id,

              // NDYRA join context
              tenant_slug: slug,
              flow: 'gym_join',

              // deterministic return paths
              success_url: successPath,
              cancel_url: cancelPath,
            }),
          });

          let data = null;
          try { data = await res.json(); } catch { /* ignore */ }

          if (!res.ok) {
            throw new Error(data?.error || `Checkout failed (HTTP ${res.status}).`);
          }

          if (!data?.url) throw new Error('Checkout session missing URL.');

          status.textContent = 'Redirecting to Stripe…';
          window.location.assign(data.url);
        } catch (err) {
          status.textContent = `Payment error: ${err?.message || err}`;
          checkoutBtn.disabled = false;
        }
      }
    });
    checkoutBtn.disabled = isLocal;
    actions.appendChild(checkoutBtn);

    actions.appendChild(el('button', {
      class: 'btn',
      text: 'Skip payment (demo)',
      onclick: () => { setStep('done'); render(); }
    }));

    box.appendChild(actions);

    box.appendChild(el('p', {
      class: 'muted',
      text: `Return URLs: ${successPath} (success) · ${cancelPath} (cancel)`
    }));

    return box;
  }

  async function renderDone(user) {
    const box = el('div');
    box.appendChild(el('h2', { text: '4) Confirmation' }));
    box.appendChild(el('p', { class: 'muted', text: 'You’re all set. Your waiver is on file.' }));

    const actions = el('div', { class: 'join-actions' });
    actions.appendChild(el('a', { class: 'btn primary', href: '/app/', text: 'Go to app' }));
    actions.appendChild(el('a', { class: 'btn', href: '/', text: 'Back to home' }));
    box.appendChild(actions);

    return box;
  }

  window.addEventListener('popstate', () => render());

  // Initial render
  render();
}

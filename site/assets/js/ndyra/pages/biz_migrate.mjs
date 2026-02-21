import { safeText } from '../lib/utils.mjs';

const STEPS = ['start', 'members', 'schedule', 'billing', 'hardware', 'confirm'];

function getStep() {
  const step = document.body?.dataset?.step || '';
  return STEPS.includes(step) ? step : 'start';
}

function stepToPath(step) {
  switch (step) {
    case 'members': return '/biz/migrate/members/';
    case 'schedule': return '/biz/migrate/schedule/';
    case 'billing': return '/biz/migrate/billing/';
    case 'hardware': return '/biz/migrate/hardware/';
    case 'confirm': return '/biz/migrate/confirm/';
    case 'start':
    default: return '/biz/migrate/';
  }
}

function nextStep(step) {
  const idx = STEPS.indexOf(step);
  if (idx < 0) return 'members';
  return STEPS[Math.min(idx + 1, STEPS.length - 1)];
}

export function init() {
  const step = getStep();

  // Show step label
  safeText(document.getElementById('migrateStep'), step);

  // Highlight current step in the list
  const items = Array.from(document.querySelectorAll('.ndyra-steps li'));
  items.forEach((li) => {
    const txt = (li.textContent || '').toLowerCase();
    // crude mapping by keyword
    const map = {
      members: 'members',
      schedule: 'schedule',
      billing: 'billing',
      hardware: 'hardware',
      confirm: 'confirm',
    };
    for (const k of Object.keys(map)) {
      if (txt.includes(k)) {
        if (map[k] === step) li.classList.add('active');
      }
    }
    if (step === 'start' && txt.includes('members')) {
      // start page: highlight the first actionable step
      li.classList.add('active');
    }
  });

  const btn = document.getElementById('migrateNext');
  if (btn) {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const n = nextStep(step);
      window.location.href = stepToPath(n);
    });
  }
}

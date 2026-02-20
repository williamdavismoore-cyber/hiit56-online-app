function render(){
  const mount = document.querySelector('[data-checkin-ui]');
  if(!mount) return;

  mount.innerHTML = `
    <p style="margin: 0 0 10px; opacity: .85;">Scaffold only. Check‑in readiness is computed server-side (waiver + membership/tokens + overrides) and must be deterministic.</p>

    <div style="display:grid; gap:10px;">
      <div class="card" style="padding: 12px;">
        <strong>Member lookup</strong>
        <div style="margin-top: 8px; opacity: .8;">(Name / email / QR — coming next checkpoint)</div>
      </div>

      <div class="card" style="padding: 12px;">
        <strong>Readiness result</strong>
        <div style="margin-top: 8px; opacity: .8;">Allowed / blocked with a reason. (coming next checkpoint)</div>
      </div>
    </div>
  `;
}

export async function init(){
  render();
}

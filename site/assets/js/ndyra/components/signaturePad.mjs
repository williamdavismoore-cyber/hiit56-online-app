// Minimal signature pad (pointer-based) for waiver signing.
// No external deps. Works on desktop + mobile.

export function createSignaturePad({ width = 560, height = 220 } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'ndyra-sigpad';

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.style.width = '100%';
  canvas.style.maxWidth = width + 'px';
  canvas.style.touchAction = 'none';
  canvas.className = 'ndyra-sigpad-canvas';

  const ctx = canvas.getContext('2d');
  // White background (important for PNG export)
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  let drawing = false;
  let last = null;

  function posFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);
    return { x, y };
  }

  function start(e) {
    drawing = true;
    last = posFromEvent(e);
  }

  function move(e) {
    if (!drawing) return;
    const p = posFromEvent(e);
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#111111';
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last = p;
  }

  function end() {
    drawing = false;
    last = null;
  }

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    start(e);
  });
  canvas.addEventListener('pointermove', (e) => {
    e.preventDefault();
    move(e);
  });
  canvas.addEventListener('pointerup', (e) => {
    e.preventDefault();
    end(e);
  });
  canvas.addEventListener('pointercancel', (e) => {
    e.preventDefault();
    end(e);
  });

  function clear() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  async function toBlob() {
    return new Promise((resolve) => {
      canvas.toBlob((b) => resolve(b), 'image/png', 1.0);
    });
  }

  wrap.appendChild(canvas);

  return {
    el: wrap,
    canvas,
    clear,
    toBlob
  };
}

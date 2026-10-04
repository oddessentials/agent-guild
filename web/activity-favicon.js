// The favicon mirrors the card label, including providers that stay active.
export const isSessionWorking = (session) => session.status !== 'exited' && session.activity === 'active';

const FRAME_MS = 100;
const FRAME_COUNT = 24;

/** One cached animation per page. Browser throttling may leave any frame visible. */
export function createActivityFavicon({
  link, reducedMotion, document = globalThis.document, Image = globalThis.Image,
  setTimer = setTimeout, clearTimer = clearTimeout, now = () => performance.now(),
}) {
  const original = link?.href;
  let frames = [], timer = null, working = false, paused = false, started = 0;

  function paint() {
    clearTimer(timer);
    timer = null;
    if (!link) return;
    const animate = working && !paused && !reducedMotion.matches && frames.length > 0;
    const frame = animate ? Math.floor((now() - started) / FRAME_MS) % frames.length : 0;
    const href = working && frames.length ? frames[frame] : original;
    if (link.href !== href) link.href = href;
    if (animate) timer = setTimer(paint, FRAME_MS);
  }

  if (link) {
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 32;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        // Encode once, not on every tick. Every frame has a distinct working ring.
        frames = Array.from({ length: FRAME_COUNT }, (_, index) => {
          ctx.clearRect(0, 0, 32, 32);
          ctx.drawImage(image, 5, 5, 22, 22);
          ctx.lineWidth = 3;
          ctx.strokeStyle = '#164e3b';
          ctx.beginPath();
          ctx.arc(16, 16, 14, 0, Math.PI * 2);
          ctx.stroke();
          ctx.strokeStyle = '#4ade80';
          ctx.lineCap = 'round';
          ctx.beginPath();
          const angle = index * Math.PI * 2 / FRAME_COUNT - Math.PI / 2;
          ctx.arc(16, 16, 14, angle, angle + Math.PI / 2);
          ctx.stroke();
          return canvas.toDataURL('image/png');
        });
        paint();
      } catch { /* An optional indicator must never prevent the cards from rendering. */ }
    };
    image.onerror = () => {}; // Retain the original favicon if the asset cannot load.
    image.src = original;
  }
  reducedMotion.addEventListener('change', paint);

  return {
    setWorking(value) {
      if (working === value) return;
      working = value;
      if (working) started = now();
      paint();
    },
    setPaused(value) {
      paused = value;
      paint();
    },
  };
}

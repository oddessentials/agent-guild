import { WORLDS, photoName } from './model.mjs';

const CREST = new URL('../brand/crest.png', import.meta.url).href;
const SITE = 'agentguild.oddessentials.ai';
const INK = '#f8ecd4', FAINT = '#c9c2b4', PANEL = 'rgba(13,20,22,.85)', PANEL_END = 'rgba(13,20,22,.6)';

async function crestImage() {
  const image = new Image();
  image.src = CREST;
  await image.decode();
  return image;
}

function canCopy() {
  return window.isSecureContext && typeof ClipboardItem === 'function' && typeof navigator.clipboard?.write === 'function'
    && (ClipboardItem.supports?.('image/png') ?? true);
}

function canShare() {
  try { return Boolean(navigator.canShare?.({ files: [new File([], 'yard.png', { type: 'image/png' })] })); } catch { return false; }
}

function fit(context, text, width) {
  if (context.measureText(text).width <= width + .5) return text;
  let cut = text;
  while (cut && context.measureText(cut + '…').width > width) cut = cut.slice(0, -1);
  return cut + '…';
}

function write(context, line, x, color) {
  context.font = line.font;
  context.fillStyle = color;
  context.fillText(fit(context, line.text, line.box.w), x, line.box.y + line.box.h / 2);
}

function shadow(context, color, blur, y) {
  context.shadowColor = color; context.shadowBlur = blur; context.shadowOffsetY = y;
}

// Tags as yard.css draws them unselected, in stage pixels.
function drawTag(context, tag) {
  context.save();
  context.textBaseline = 'middle';
  if (tag.kind === 'chip') {
    const { x, y, w, h } = tag.box;
    shadow(context, 'rgba(0,0,0,.33)', 10, 2);
    context.beginPath(); context.roundRect(x, y, w, h, 10);
    context.fillStyle = PANEL; context.fill();
    shadow(context, 'transparent', 0, 0);
    context.strokeStyle = 'rgba(224,191,121,.27)'; context.lineWidth = 1; context.stroke();
    context.textAlign = 'center';
    shadow(context, '#000', 3, 1);
    write(context, tag.lines[0], x + w / 2, INK);
    context.restore();
    return;
  }
  const bottom = tag.box.y + tag.box.h, name = tag.lines[0].box;
  const box = tag.kind === 'session' ? { x: name.x - 6, y: bottom - name.h - 8, w: name.w + 12, h: name.h + 8 } : tag.box;
  const lines = tag.kind === 'session' ? [{ ...tag.lines[0], box: { ...name, y: box.y + 3 } }] : tag.lines;
  const color = tag.color || '#ac9362';
  context.globalAlpha = tag.status === 'exited' ? .5 : tag.kind === 'session' ? .82 : 1;
  shadow(context, 'rgba(0,0,0,.33)', 12, 2);
  context.beginPath(); context.roundRect(box.x, box.y, box.w, box.h, 4);
  const fill = context.createLinearGradient(0, box.y, 0, bottom);
  fill.addColorStop(0, PANEL); fill.addColorStop(1, PANEL_END);
  context.fillStyle = fill; context.fill();
  shadow(context, 'transparent', 0, 0);
  context.save();
  context.clip();
  if (tag.status === 'locked') {
    context.strokeStyle = color; context.lineWidth = 2; context.setLineDash([4, 3]);
    context.beginPath(); context.moveTo(box.x, bottom - 1); context.lineTo(box.x + box.w, bottom - 1); context.stroke();
  } else {
    context.fillStyle = color; context.fillRect(box.x, bottom - 2, box.w, 2);
  }
  context.restore();
  shadow(context, '#000', 3, 1);
  lines.forEach((line, i) => write(context, line, line.box.x, i ? FAINT : INK));
  context.restore();
}

function drawSignature(context, skin, crest, width, height) {
  const title = WORLDS[skin].title;
  const display = getComputedStyle(document.documentElement).getPropertyValue('--font-display').trim() || 'serif';
  const titleFont = `600 15px ${display}`, siteFont = `500 10px ${getComputedStyle(document.body).fontFamily}`;
  context.save();
  context.font = titleFont; const titleWidth = context.measureText(title).width;
  context.font = siteFont; const siteWidth = context.measureText(SITE).width;
  const mark = crest && skin !== 'professional' ? 34 : 0, markWidth = mark && mark * crest.naturalWidth / crest.naturalHeight;
  const pad = 10, w = pad * 2 + (mark ? markWidth + 10 : 0) + Math.max(titleWidth, siteWidth), h = pad * 2 + 34;
  const x = width - w - 14, y = height - h - 14, left = x + pad + (mark ? markWidth + 10 : 0);
  shadow(context, 'rgba(0,0,0,.33)', 12, 2);
  context.beginPath(); context.roundRect(x, y, w, h, 8);
  context.fillStyle = 'rgba(13,20,22,.72)'; context.fill();
  shadow(context, 'transparent', 0, 0);
  if (mark) context.drawImage(crest, x + pad, y + (h - mark) / 2, markWidth, mark);
  context.textBaseline = 'top';
  context.font = titleFont; context.fillStyle = INK; context.fillText(title, left, y + pad + 1);
  context.font = siteFont; context.fillStyle = FAINT; context.fillText(SITE, left, y + pad + 22);
  context.restore();
}

export class YardPhoto {
  constructor(dialog) {
    this.dialog = dialog;
    this.preview = dialog.querySelector('canvas');
    this.labels = dialog.querySelector('[data-labels]');
    this.status = dialog.querySelector('[role="status"]');
    this.copyButton = dialog.querySelector('[data-copy]');
    this.saveButton = dialog.querySelector('[data-save]');
    this.shareButton = dialog.querySelector('[data-share]');
    this.shot = null; this.png = null; this.blob = null; this.url = ''; this.version = 0; this.opening = false;
    this.crest = crestImage().catch(() => null);
    this.labels.addEventListener('change', () => { this.draw(); this.status.textContent = ''; });
    this.copyButton.addEventListener('click', () => this.copy());
    this.saveButton.addEventListener('click', () => this.save());
    this.shareButton.addEventListener('click', () => this.share());
    dialog.querySelector('[data-done]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      if (dialog.open) return;
      this.clear(); this.opener?.focus();
    });
  }

  async open(renderer, opener) {
    if (this.dialog.open || this.opening) return;
    const version = this.version;
    this.opening = true;
    try {
      const display = getComputedStyle(document.documentElement).getPropertyValue('--font-display');
      const [crest] = await Promise.all([this.crest, document.fonts.load(`600 15px ${display}`).catch(() => {})]);
      const stage = document.getElementById('yard-stage');
      if (version !== this.version || !(stage.checkVisibility?.() ?? stage.isConnected) || !stage.clientWidth || !stage.clientHeight) return;
      let shot = null;
      try { shot = renderer.capture(); } catch {}
      Object.assign(this, { shot, opener, crestImage: crest, taken: new Date(), background: getComputedStyle(document.getElementById('yard')).backgroundColor });
      this.labels.checked = false;
      try { this.draw(); } catch { shot.canvas.width = 0; this.shot = shot = null; this.draw(); }
      this.labels.parentElement.hidden = !shot;
      this.copyButton.hidden = !shot || !canCopy();
      this.shareButton.hidden = !shot || !canShare();
      this.saveButton.hidden = !shot;
      this.status.textContent = shot ? '' : 'Couldn’t take the picture.';
      this.dialog.showModal();
      [this.copyButton, this.saveButton, this.dialog.querySelector('[data-done]')].find(button => !button.hidden).focus();
    } finally { this.opening = false; }
  }

  draw() {
    this.version++;
    this.png = null; this.blob = null;
    const { shot, preview } = this;
    if (!shot) { preview.width = preview.height = 0; return; }
    preview.width = shot.canvas.width; preview.height = shot.canvas.height;
    const context = preview.getContext('2d');
    context.fillStyle = this.background;
    context.fillRect(0, 0, preview.width, preview.height);
    context.drawImage(shot.canvas, 0, 0);
    context.save();
    context.scale(shot.scale, shot.scale);
    if (this.labels.checked) for (const tag of shot.tags) drawTag(context, tag);
    drawSignature(context, shot.skin, this.crestImage, preview.width / shot.scale, preview.height / shot.scale);
    context.restore();
  }

  encode() {
    if (this.png) return this.png;
    const png = this.png = new Promise((resolve, reject) => this.preview.toBlob(blob => blob ? resolve(blob) : reject(new Error('The picture could not be encoded.')), 'image/png'));
    png.then(blob => { if (this.png === png) this.blob = blob; }, () => { if (this.png === png) this.png = null; });
    return png;
  }

  name() { return photoName(WORLDS[this.shot.skin].title, this.taken); }

  isCurrent(version) { return version === this.version && this.dialog.open; }

  report(version, text) {
    if (this.isCurrent(version)) this.status.textContent = text;
  }

  async copy() {
    const version = this.version;
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': this.encode() })]);
      this.report(version, 'Copied');
    } catch { this.report(version, 'Couldn’t copy the picture.'); }
  }

  async save() {
    const version = this.version, name = this.name();
    try {
      const blob = await this.encode();
      if (!this.isCurrent(version)) return;
      URL.revokeObjectURL(this.url);
      this.url = URL.createObjectURL(blob);
      Object.assign(document.createElement('a'), { href: this.url, download: name }).click();
      this.report(version, 'Saved ' + name);
    } catch { this.report(version, 'Couldn’t save the picture.'); }
  }

  async share() {
    const version = this.version, name = this.name(), ready = this.blob;
    try {
      const blob = ready || await this.encode();
      if (!this.isCurrent(version)) return;
      const file = new File([blob], name, { type: 'image/png' });
      await navigator.share({ files: [file] });
      this.report(version, 'Shared');
    } catch (err) {
      if (err?.name === 'AbortError') return;
      this.report(version, err?.name === 'NotAllowedError' && !ready ? 'The picture is ready. Press Share again.' : 'Couldn’t share the picture.');
    }
  }

  close() {
    this.clear();
    if (this.dialog.open) this.dialog.close();
  }

  clear() {
    this.version++;
    URL.revokeObjectURL(this.url);
    if (this.shot) this.shot.canvas.width = 0;
    this.shot = null; this.png = null; this.blob = null; this.url = '';
    this.preview.width = this.preview.height = 0;
    this.status.textContent = '';
  }
}

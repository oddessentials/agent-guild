import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { timingSafeEqualString } from './session-manager.mjs';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
export const SIGN_IN_LIFETIME_MS = 5 * 60 * 1000;
export const SIGN_IN_INTERVAL_S = 3;
export const MAX_SIGN_INS = 5;
export const SIGN_IN_THROTTLE_MS = 2000;

function refusal(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

export function normalizeSignInCode(value) {
  return typeof value === 'string' ? value.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
}

export function formatSignInCode(code) {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export class DeviceSignIn extends EventEmitter {
  constructor({ token, now = Date.now, random = crypto.randomBytes, timers = { set: setTimeout, clear: clearTimeout } } = {}) {
    super();
    Object.assign(this, { token, now, random, timers });
    this.requests = new Map();
    this.lastRequestAt = -Infinity;
    this.timer = null;
    this.closed = false;
  }

  request() {
    this.sweep();
    const at = this.now();
    if (this.closed || this.requests.size >= MAX_SIGN_INS || at - this.lastRequestAt < SIGN_IN_THROTTLE_MS) {
      throw refusal(429, 'sign_in_busy', 'Too many devices are asking to sign in. Try again in a moment.');
    }
    const code = this.newCode();
    const device = this.random(24).toString('hex');
    const entry = { code, device, status: 'pending', requestedAt: new Date(at).toISOString(), expiresAt: new Date(at + SIGN_IN_LIFETIME_MS).toISOString() };
    this.requests.set(code, entry);
    this.lastRequestAt = at;
    this.changed();
    return { code: formatSignInCode(code), device, expiresAt: entry.expiresAt, interval: SIGN_IN_INTERVAL_S };
  }

  poll(device) {
    this.sweep();
    const entry = [...this.requests.values()].find((candidate) => timingSafeEqualString(candidate.device, device));
    if (!entry) throw refusal(404, 'sign_in_unknown', 'This sign-in is unknown or has expired. Ask for a new code.');
    if (entry.status === 'pending') return { status: 'pending' };
    this.requests.delete(entry.code);
    this.changed();
    return entry.status === 'approved' ? { status: 'approved', token: this.token } : { status: 'denied' };
  }

  list() {
    this.sweep();
    return { requests: [...this.requests.values()].filter((entry) => entry.status === 'pending')
      .map(({ code, requestedAt, expiresAt }) => ({ code: formatSignInCode(code), requestedAt, expiresAt })) };
  }

  approve(code) { return this.decide(code, 'approved'); }

  deny(code) { return this.decide(code, 'denied'); }

  decide(code, status) {
    this.sweep();
    const entry = this.requests.get(normalizeSignInCode(code));
    if (!entry || entry.status !== 'pending') throw refusal(404, 'sign_in_unknown', 'No device is waiting with that code. It may have expired.');
    entry.status = status;
    this.changed();
    return this.list();
  }

  close() {
    this.closed = true;
    this.timers.clear(this.timer);
    this.timer = null;
    this.requests.clear();
  }

  newCode() {
    for (;;) {
      const bytes = this.random(CODE_LENGTH);
      const code = [...bytes].map((byte) => ALPHABET[byte % ALPHABET.length]).join('');
      if (!this.requests.has(code)) return code;
    }
  }

  sweep() {
    const at = this.now();
    let removed = false;
    for (const [code, entry] of this.requests) {
      if (Date.parse(entry.expiresAt) <= at) { this.requests.delete(code); removed = true; }
    }
    if (removed) this.changed();
  }

  changed() {
    this.timers.clear(this.timer);
    this.timer = null;
    const next = Math.min(...[...this.requests.values()].map((entry) => Date.parse(entry.expiresAt)));
    if (Number.isFinite(next) && !this.closed) {
      this.timer = this.timers.set(() => this.sweep(), Math.max(0, next - this.now()));
      this.timer?.unref?.();
    }
    if (!this.closed) this.emit('updated');
  }
}

/**
 * brute_force.js — Brute-force engine running in main thread
 * Phases: 1) Dictionary attack  2) Sweep 00000→99999
 * Emits progress via callbacks.
 */

import { writeAndVerify } from './serial.js';

const RANGE_END = 99999;

export class BruteForceEngine {
  constructor({ config, onProgress, onFound, onNotFound, onStatus, onLockout, onVerbose }) {
    this.cfg        = config;       // {r, v, pw, d, la, ld, ck} from server
    this.onProgress = onProgress;
    this.onFound    = onFound;
    this.onNotFound = onNotFound;
    this.onStatus   = onStatus;
    this.onLockout  = onLockout;
    this.onVerbose  = onVerbose;    // optional: (code, raw) → called every attempt
    this._abort     = false;
    this._paused    = false;
    this.attempts   = 0;
    this.startTime  = 0;
  }

  stop()   { this._abort  = true; }
  pause()  { this._paused = true; }
  resume() { this._paused = false; }

  async run() {
    const { r: pwReg, v: verReg, pw: dictPws, d: delayMs, la: lockoutAfter,
            ld: lockoutDelay, ck: checkType } = this.cfg;
    this.startTime = Date.now();
    this.attempts  = 0;

    // ── Phase 1: Dictionary attack ─────────────────────────────── //
    this.onStatus('Phase 1: Dictionary attack...');
    for (const pw of dictPws) {
      if (this._abort) return;
      this.onStatus(`Dict → trying: ${String(pw).padStart(5, '0')}`);
      const { unlocked, raw } = await writeAndVerify(pwReg, verReg, pw, checkType, delayMs);
      this.attempts++;
      // Verbose: log raw register value every attempt in dict phase
      if (this.onVerbose) {
        const hexRaw = raw !== null ? `0x${raw.toString(16).toUpperCase().padStart(4,'0')}` : 'null (timeout)';
        this.onVerbose(pw, hexRaw, unlocked);
      }
      if (unlocked) { this.onFound(pw, this.attempts); return; }
      await this._sleep(delayMs);
    }

    // ── Phase 2: Brute-force sweep ────────────────────────────── //
    this.onStatus('Phase 2: Brute-force 00000 → 99999...');
    const dictSet = new Set(dictPws);

    for (let code = 0; code <= RANGE_END; code++) {
      if (this._abort) return;
      await this._waitIfPaused();
      if (dictSet.has(code)) continue;   // already tried

      // Anti-lockout
      if (lockoutAfter && this.attempts > 0 && this.attempts % lockoutAfter === 0) {
        this.onLockout(this.attempts);
        await this._sleep(lockoutDelay * 1000);
      }

      const { unlocked, raw } = await writeAndVerify(pwReg, verReg, code, checkType, delayMs);
      this.attempts++;

      // Verbose: log raw value every attempt (check verbose checkbox)
      if (this.onVerbose) {
        const hexRaw = raw !== null ? `0x${raw.toString(16).toUpperCase().padStart(4,'0')}` : 'null';
        this.onVerbose(code, hexRaw, unlocked);
      }

      if (unlocked) { this.onFound(code, this.attempts); return; }

      // Emit progress every 100 attempts
      if (this.attempts % 100 === 0) {
        const elapsed = (Date.now() - this.startTime) / 1000;
        const speed   = this.attempts / Math.max(elapsed, 0.001);
        this.onProgress(code, RANGE_END, speed);
      }

      await this._sleep(delayMs);
    }

    this.onNotFound();
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, Math.max(ms, 1))); }

  async _waitIfPaused() {
    while (this._paused && !this._abort) {
      await this._sleep(100);
    }
  }
}

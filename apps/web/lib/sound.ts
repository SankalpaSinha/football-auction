'use client';
import type { GameEvent } from '@fa/shared';

/**
 * Tiny synthesised sound kit (Web Audio) — no assets to license, nothing loud.
 */
class SoundKit {
  private ctx: AudioContext | null = null;
  enabled = true;

  /** Create/resume the context. Safe to call from any user gesture, even while muted. */
  private context(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      this.ctx = new Ctor();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  private audio(): AudioContext | null {
    return this.enabled ? this.context() : null;
  }

  /** Call from user gestures so browsers (notably iOS) allow — and keep allowing — audio. */
  unlock() {
    this.context();
  }

  private tone(freq: number, dur: number, opts: { type?: OscillatorType; gain?: number; delay?: number; slideTo?: number } = {}) {
    const ctx = this.audio();
    if (!ctx) return;
    const t = ctx.currentTime + (opts.delay ?? 0);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = opts.type ?? 'sine';
    osc.frequency.setValueAtTime(freq, t);
    if (opts.slideTo) osc.frequency.exponentialRampToValueAtTime(opts.slideTo, t + dur);
    const peak = opts.gain ?? 0.06;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  bid() {
    this.tone(880, 0.09, { type: 'triangle', gain: 0.05 });
  }
  myBid() {
    this.tone(660, 0.07, { type: 'triangle', gain: 0.05 });
    this.tone(990, 0.1, { type: 'triangle', gain: 0.05, delay: 0.06 });
  }
  outbid() {
    this.tone(520, 0.12, { type: 'sawtooth', gain: 0.03 });
    this.tone(390, 0.18, { type: 'sawtooth', gain: 0.03, delay: 0.1 });
  }
  tick(urgent: boolean) {
    this.tone(urgent ? 1400 : 1100, 0.04, { type: 'square', gain: 0.018 });
  }
  lotOpen() {
    this.tone(300, 0.25, { type: 'sine', gain: 0.04, slideTo: 700 });
  }
  sold() {
    this.tone(110, 0.18, { type: 'square', gain: 0.05 });
    [523, 659, 784].forEach((f, i) => this.tone(f, 0.35, { type: 'triangle', gain: 0.04, delay: 0.12 + i * 0.07 }));
  }
  unsold() {
    this.tone(330, 0.2, { type: 'sine', gain: 0.03, slideTo: 220 });
  }
  start() {
    [392, 523, 784].forEach((f, i) => this.tone(f, 0.22, { type: 'triangle', gain: 0.05, delay: i * 0.14 }));
  }
  complete() {
    [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.4, { type: 'triangle', gain: 0.045, delay: i * 0.1 }));
  }

  winner() {
    [523, 659, 784, 1046, 1318].forEach((f, i) => this.tone(f, 0.5, { type: 'triangle', gain: 0.05, delay: i * 0.12 }));
    this.tone(1568, 0.9, { type: 'sine', gain: 0.035, delay: 0.65 });
  }

  onEvent(e: GameEvent, me: string) {
    switch (e.type) {
      case 'LOT_OPEN':
        return this.lotOpen();
      case 'BID':
        if (e.userId === me) return this.myBid();
        if (e.previousBidderId === me) return this.outbid();
        return this.bid();
      case 'SOLD':
        return this.sold();
      case 'UNSOLD':
        return this.unsold();
      case 'GAME_STARTING':
        return this.start();
      case 'AUCTION_COMPLETE':
      case 'LINEUPS_REVEALED':
        return this.complete();
      case 'LINEUP_LOCKED':
        return this.bid();
      case 'RESULTS':
        return; // the results screen plays its own reveal sounds
    }
  }
}

export const sound = new SoundKit();

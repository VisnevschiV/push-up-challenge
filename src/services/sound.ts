class SoundEngine {
  private ctx: AudioContext | null = null;
  public enabled = true;
  public hapticsEnabled = true;

  private ensureContext(): AudioContext | null {
    if (!this.enabled) return null;
    if (!this.ctx && typeof window !== 'undefined') {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  public unlock(): void {
    this.ensureContext();
  }

  public vibrate(pattern: number | number[]): void {
    if (!this.hapticsEnabled) return;
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try {
        navigator.vibrate(pattern);
      } catch {
        // Ignore unsupported vibration errors
      }
    }
  }

  private playTone(freq: number, durationSec: number, type: OscillatorType = 'sine', gainPeak = 0.16, delaySec = 0): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const start = ctx.currentTime + delaySec;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);

    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(gainPeak, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + durationSec);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(start);
    osc.stop(start + durationSec + 0.02);
  }

  /** Plays when phone settles flat face-up on the floor */
  public playFlatLocked(): void {
    this.vibrate(35);
    this.playTone(523.25, 0.11, 'triangle', 0.14, 0);
    this.playTone(783.99, 0.18, 'triangle', 0.16, 0.09);
  }

  /** Subtle depth click when chest reaches the bottom threshold */
  public playBottomDepth(): void {
    this.vibrate(20);
    this.playTone(330, 0.065, 'sine', 0.12, 0);
  }

  /** Crisp ascending chime when full rep completes at the top */
  public playRepCounted(repCount: number, isGoalReached = false): void {
    if (isGoalReached) {
      this.vibrate([50, 40, 80]);
      [523.25, 659.25, 783.99, 1046.5].forEach((f, idx) => {
        this.playTone(f, 0.22, 'triangle', 0.18, idx * 0.075);
      });
      return;
    }

    if (repCount > 0 && repCount % 10 === 0) {
      this.vibrate([35, 30, 50]);
      this.playTone(659.25, 0.11, 'triangle', 0.17, 0);
      this.playTone(987.77, 0.2, 'triangle', 0.2, 0.08);
      return;
    }

    this.vibrate(35);
    const pitchBoost = Math.min((repCount % 10) * 18, 160);
    this.playTone(587.33 + pitchBoost, 0.13, 'triangle', 0.18, 0);
  }
}

export const soundEngine = new SoundEngine();

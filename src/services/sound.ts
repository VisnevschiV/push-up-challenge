class SoundEngine {
  private ctx: AudioContext | null = null;
  public soundEnabled = true;
  public spokenEnabled = true;
  public hapticsEnabled = true;

  private ensureContext(): AudioContext | null {
    if (!this.soundEnabled) return null;
    if (!this.ctx && typeof window !== 'undefined') {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
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
    if (this.spokenEnabled && typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        // Warm up speech synthesis on mobile user gesture
        const warm = new SpeechSynthesisUtterance('');
        warm.volume = 0;
        window.speechSynthesis.speak(warm);
      } catch {
        // Ignore unsupported speech synthesis
      }
    }
  }

  public speak(text: string): void {
    if (!this.spokenEnabled || typeof window === 'undefined' || !('speechSynthesis' in window)) {
      return;
    }
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.15;
      u.pitch = 1.0;
      u.volume = 0.95;
      window.speechSynthesis.speak(u);
    } catch {
      // Ignore speech synthesis errors
    }
  }

  public vibrate(pattern: number | number[]): void {
    if (!this.hapticsEnabled) return;
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try {
        navigator.vibrate(pattern);
      } catch {
        // Ignore unsupported vibration
      }
    }
  }

  private playTone(
    freq: number,
    durationSec: number,
    type: OscillatorType = 'sine',
    gainPeak = 0.15,
    delaySec = 0
  ): void {
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

  public playFlatLocked(): void {
    this.vibrate(35);
    this.playTone(523.25, 0.1, 'triangle', 0.14, 0);
    this.playTone(783.99, 0.16, 'triangle', 0.16, 0.085);
  }

  public playBottomDepth(): void {
    this.vibrate(18);
    this.playTone(340, 0.06, 'sine', 0.11, 0);
  }

  public playRepCounted(repCount: number, announceText?: string, isSetOrGoalDone = false): void {
    if (isSetOrGoalDone) {
      this.vibrate([45, 35, 75]);
      [523.25, 659.25, 783.99, 1046.5].forEach((f, idx) => {
        this.playTone(f, 0.2, 'triangle', 0.17, idx * 0.07);
      });
    } else {
      this.vibrate(32);
      const pitchBoost = Math.min((repCount % 10) * 16, 150);
      this.playTone(587.33 + pitchBoost, 0.12, 'triangle', 0.17, 0);
    }

    this.speak(announceText ?? String(repCount));
  }

  public playRestFinished(): void {
    this.vibrate([40, 40, 60]);
    this.playTone(659.25, 0.12, 'triangle', 0.16, 0);
    this.playTone(880, 0.2, 'triangle', 0.18, 0.1);
    this.speak('Next set. Go!');
  }
}

export const soundEngine = new SoundEngine();

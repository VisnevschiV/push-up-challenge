export interface OrientationSnapshot {
  permissionState: 'prompt' | 'granted' | 'denied' | 'unsupported';
  hasHardwareEvents: boolean;
  manualFlatOverride: boolean;
  beta: number; // Front-back tilt (-180 to 180)
  gamma: number; // Left-right tilt (-90 to 90)
  tiltDeg: number; // Combined angle from horizontal
  isFaceUp: boolean;
  isWithinFlatAngle: boolean;
  isFlatLocked: boolean; // Settled flat face-up for >= 600ms (or manual override)
  settleProgress: number; // 0..1
}

type OrientationListener = (snap: OrientationSnapshot) => void;

interface DeviceOrientationEventiOS extends DeviceOrientationEvent {
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

const SETTLE_MS = 600;

export class GroundOrientationMonitor {
  private listeners = new Set<OrientationListener>();
  private toleranceDeg = 12;
  private permissionState: OrientationSnapshot['permissionState'] = 'prompt';
  private hasHardwareEvents = false;
  private manualFlatOverride = false;

  private beta = 0;
  private gamma = 0;
  private isFaceUp = true;
  private flatSinceTs: number | null = null;
  private isFlatLocked = false;
  private rafId: number | null = null;
  private started = false;

  public setToleranceDeg(deg: number): void {
    this.toleranceDeg = Math.max(5, Math.min(25, deg));
    this.emit();
  }

  public setManualFlatOverride(override: boolean): void {
    this.manualFlatOverride = override;
    this.emit();
  }

  public subscribe(fn: OrientationListener): () => void {
    this.listeners.add(fn);
    fn(this.getSnapshot());
    return () => {
      this.listeners.delete(fn);
    };
  }

  public needsExplicitPermissionGesture(): boolean {
    if (typeof window === 'undefined' || typeof DeviceOrientationEvent === 'undefined') {
      return false;
    }
    const DevOrient = DeviceOrientationEvent as unknown as DeviceOrientationEventiOS;
    return typeof DevOrient.requestPermission === 'function' && this.permissionState === 'prompt';
  }

  public async requestAndStart(): Promise<boolean> {
    if (typeof window === 'undefined') return false;

    if (typeof DeviceOrientationEvent === 'undefined') {
      this.permissionState = 'unsupported';
      this.emit();
      return false;
    }

    const DevOrient = DeviceOrientationEvent as unknown as DeviceOrientationEventiOS;
    if (typeof DevOrient.requestPermission === 'function') {
      try {
        const res = await DevOrient.requestPermission();
        this.permissionState = res === 'granted' ? 'granted' : 'denied';
        if (res !== 'granted') {
          this.emit();
          return false;
        }
      } catch {
        this.permissionState = 'denied';
        this.emit();
        return false;
      }
    } else {
      this.permissionState = 'granted';
    }

    this.startListening();
    return true;
  }

  public startListening(): void {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;
    window.addEventListener('deviceorientation', this.handleOrientation, true);
    this.tickLoop();
  }

  public stopListening(): void {
    if (!this.started || typeof window === 'undefined') return;
    this.started = false;
    window.removeEventListener('deviceorientation', this.handleOrientation, true);
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private handleOrientation = (e: DeviceOrientationEvent): void => {
    if (e.beta === null || e.gamma === null) return;
    this.hasHardwareEvents = true;
    this.permissionState = 'granted';
    this.beta = e.beta;
    this.gamma = e.gamma;
    // Face-up on horizontal surface has |beta| < 90 and |gamma| < 90.
    // Face-down has |beta| near 180.
    this.isFaceUp = Math.abs(e.beta) < 90;
  };

  private tickLoop = (): void => {
    if (!this.started) return;
    const now = performance.now();

    if (this.hasHardwareEvents && !this.manualFlatOverride) {
      const tilt = Math.hypot(this.beta, this.gamma);
      // Use hysteresis: tighter angle to acquire lock, slightly wider (+5 deg) before dropping lock
      // so floor vibrations don't interrupt a set, while picking up the phone immediately disarms.
      const activeThreshold = this.isFlatLocked ? this.toleranceDeg + 5 : this.toleranceDeg;
      const flatNow = this.isFaceUp && tilt <= activeThreshold;

      if (flatNow) {
        if (this.flatSinceTs === null) {
          this.flatSinceTs = now;
        }
        const elapsed = now - this.flatSinceTs;
        if (elapsed >= SETTLE_MS) {
          this.isFlatLocked = true;
        }
      } else {
        this.flatSinceTs = null;
        this.isFlatLocked = false;
      }
    }

    this.emit();
    this.rafId = requestAnimationFrame(this.tickLoop);
  };

  public getSnapshot(): OrientationSnapshot {
    if (this.manualFlatOverride) {
      return {
        permissionState: this.permissionState,
        hasHardwareEvents: this.hasHardwareEvents,
        manualFlatOverride: true,
        beta: 0,
        gamma: 0,
        tiltDeg: 0,
        isFaceUp: true,
        isWithinFlatAngle: true,
        isFlatLocked: true,
        settleProgress: 1,
      };
    }

    const tiltDeg = Math.hypot(this.beta, this.gamma);
    const activeThreshold = this.isFlatLocked ? this.toleranceDeg + 5 : this.toleranceDeg;
    const isWithinFlatAngle = this.hasHardwareEvents && this.isFaceUp && tiltDeg <= activeThreshold;
    const settleProgress =
      this.flatSinceTs !== null
        ? Math.min(1, (performance.now() - this.flatSinceTs) / SETTLE_MS)
        : 0;

    return {
      permissionState: this.permissionState,
      hasHardwareEvents: this.hasHardwareEvents,
      manualFlatOverride: false,
      beta: this.beta,
      gamma: this.gamma,
      tiltDeg,
      isFaceUp: this.isFaceUp,
      isWithinFlatAngle,
      isFlatLocked: this.isFlatLocked,
      settleProgress: this.isFlatLocked ? 1 : settleProgress,
    };
  }

  private emit(): void {
    const snap = this.getSnapshot();
    this.listeners.forEach((fn) => fn(snap));
  }
}

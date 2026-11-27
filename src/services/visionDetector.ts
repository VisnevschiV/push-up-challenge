import type { SensitivityPreset } from './challengeStore';

export type RepPhase = 'DISARMED' | 'CALIBRATING' | 'UP' | 'DESCENDING' | 'BOTTOM';

export interface VisionTelemetry {
  cameraActive: boolean;
  cameraError: string | null;
  phase: RepPhase;
  proximity: number; // 0..1 smoothed depth signal
  downThreshold: number;
  upThreshold: number;
  baselineLuma: number;
  centerLuma: number;
  isDarkAmbient: boolean;
  fps: number;
}

export interface VisionCallbacks {
  onTelemetry: (telemetry: VisionTelemetry) => void;
  onBottomReached: () => void;
  onRepCompleted: (peakDepthPct: number) => void;
}

const W = 64;
const H = 48;

const PRESET_THRESHOLDS: Record<SensitivityPreset, { down: number; up: number }> = {
  strict: { down: 0.62, up: 0.25 },
  standard: { down: 0.5, up: 0.23 },
  relaxed: { down: 0.38, up: 0.2 },
};

export class FrontCameraPushUpDetector {
  private callbacks: VisionCallbacks;
  private stream: MediaStream | null = null;
  private videoEl: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private prevInnerLuma: Float32Array = new Float32Array(W * H);

  private running = false;
  private isArmed = false;
  private sensitivity: SensitivityPreset = 'standard';

  private calibrationFrames = 0;
  private baselineLuma = 120;
  private baselineGrad = 12;
  private smoothedProximity = 0;
  private simulatedProximity: number | null = null;

  private phase: RepPhase = 'DISARMED';
  private bottomEnteredAt = 0;
  private lastRepAt = 0;
  private peakProximityInRep = 0;

  private rafId: number | null = null;
  private lastAnalysisTs = 0;
  private fps = 30;

  constructor(callbacks: VisionCallbacks) {
    this.callbacks = callbacks;
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  public setSensitivity(preset: SensitivityPreset): void {
    this.sensitivity = preset;
  }

  public setArmed(armed: boolean): void {
    if (this.isArmed === armed) return;
    this.isArmed = armed;
    if (!armed) {
      // Immediately cancel any partial movement if phone is tilted or picked up
      this.phase = 'DISARMED';
      this.peakProximityInRep = 0;
    } else {
      this.recalibrate();
    }
  }

  public recalibrate(): void {
    this.calibrationFrames = 0;
    this.smoothedProximity = 0;
    this.peakProximityInRep = 0;
    this.phase = this.isArmed ? 'CALIBRATING' : 'DISARMED';
  }

  /** Allows interactive push-up testing on desktop or when camera is unavailable */
  public setSimulatedProximity(val: number | null): void {
    this.simulatedProximity = val;
  }

  public async startCamera(videoElement: HTMLVideoElement): Promise<boolean> {
    this.videoEl = videoElement;
    this.running = true;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this.emitTelemetry(false, 'Camera API unavailable (requires HTTPS or localhost).');
      this.startLoop();
      return false;
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'user' },
          width: { ideal: 480 },
          height: { ideal: 360 },
          frameRate: { ideal: 30, max: 30 },
        },
      });
      videoElement.srcObject = this.stream;
      videoElement.setAttribute('playsinline', 'true');
      videoElement.muted = true;
      await videoElement.play();
      this.recalibrate();
      this.startLoop();
      return true;
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.name === 'NotAllowedError'
            ? 'Camera permission denied. Allow camera access or use Test Push button.'
            : err.message
          : 'Could not open front camera.';
      this.emitTelemetry(false, msg);
      this.startLoop();
      return false;
    }
  }

  public stop(): void {
    this.running = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.videoEl) {
      this.videoEl.srcObject = null;
    }
  }

  private startLoop(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.lastAnalysisTs = performance.now();
    this.loop();
  }

  private loop = (): void => {
    if (!this.running) return;
    const now = performance.now();
    const dt = now - this.lastAnalysisTs;

    // Target ~30 FPS analysis (~32ms interval)
    if (dt >= 30) {
      this.fps = Math.round(0.85 * this.fps + 0.15 * (1000 / Math.max(1, dt)));
      this.lastAnalysisTs = now;
      this.processFrame(now);
    }

    this.rafId = requestAnimationFrame(this.loop);
  };

  private processFrame(now: number): void {
    const thresholds = PRESET_THRESHOLDS[this.sensitivity];
    const hasLiveVideo =
      this.videoEl !== null &&
      this.stream !== null &&
      this.videoEl.readyState >= 2 &&
      this.videoEl.videoWidth > 0;

    let centerLuma = this.baselineLuma;

    if (this.simulatedProximity !== null) {
      // Interactive simulation mode
      if (this.phase === 'CALIBRATING') {
        this.phase = 'UP';
      }
      this.smoothedProximity = 0.55 * this.smoothedProximity + 0.45 * this.simulatedProximity;
      this.advanceStateMachine(now, thresholds);
      this.emitTelemetry(hasLiveVideo, null);
      return;
    }

    if (!hasLiveVideo || !this.ctx || !this.videoEl) {
      this.emitTelemetry(
        false,
        this.stream ? null : 'Camera feed inactive — use Hold-to-Rep button below to test.'
      );
      return;
    }

    this.ctx.drawImage(this.videoEl, 0, 0, W, H);
    const data = this.ctx.getImageData(0, 0, W, H).data;

    // Inner ROI: central 50% width x 58% height directly above front lens
    const xMin = Math.floor(W * 0.25);
    const xMax = Math.floor(W * 0.75);
    const yMin = Math.floor(H * 0.21);
    const yMax = Math.floor(H * 0.79);

    let innerSum = 0;
    let innerCount = 0;
    let outerSum = 0;
    let outerCount = 0;
    let darkPixels = 0;
    let gradSum = 0;
    let motionSum = 0;

    const shadowCutoff = this.baselineLuma * 0.62;

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const idx = (y * W + x) * 4;
        const luma = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
        const pIdx = y * W + x;

        const inInner = x >= xMin && x < xMax && y >= yMin && y < yMax;
        if (inInner) {
          innerSum += luma;
          innerCount++;
          if (luma < shadowCutoff) darkPixels++;

          motionSum += Math.abs(luma - this.prevInnerLuma[pIdx]);
          if (x > xMin && y > yMin) {
            const leftLuma = this.prevInnerLuma[pIdx - 1];
            const topLuma = this.prevInnerLuma[pIdx - W];
            gradSum += Math.abs(luma - leftLuma) + Math.abs(luma - topLuma);
          }
        } else {
          outerSum += luma;
          outerCount++;
        }
        this.prevInnerLuma[pIdx] = luma;
      }
    }

    centerLuma = innerSum / Math.max(1, innerCount);
    const outerLuma = outerSum / Math.max(1, outerCount);
    const darkRatio = darkPixels / Math.max(1, innerCount);
    const meanGrad = gradSum / Math.max(1, innerCount);
    const meanMotion = motionSum / Math.max(1, innerCount);

    if (!this.isArmed) {
      this.phase = 'DISARMED';
      this.smoothedProximity = 0;
      this.emitTelemetry(true, null, centerLuma);
      return;
    }

    // Initial baseline lock (~18 frames = ~0.6s in plank top position)
    if (this.calibrationFrames < 18) {
      this.phase = 'CALIBRATING';
      const alpha = this.calibrationFrames === 0 ? 1 : 0.22;
      this.baselineLuma = (1 - alpha) * this.baselineLuma + alpha * centerLuma;
      this.baselineGrad = (1 - alpha) * this.baselineGrad + alpha * meanGrad;
      this.calibrationFrames++;
      if (this.calibrationFrames >= 18) {
        this.phase = 'UP';
      }
      this.emitTelemetry(true, null, centerLuma);
      return;
    }

    // Compute multi-cue near-field proximity (0 = plank top, 1 = chest close to camera)
    let rawProximity = 0;
    const isDarkAmbient = this.baselineLuma < 36;

    if (!isDarkAmbient) {
      // Standard / lit room: body descending blocks overhead & ambient room light + blurs near-field focus
      const relDrop = Math.max(
        0,
        Math.min(1, (this.baselineLuma - centerLuma) / Math.max(this.baselineLuma * 0.58, 20))
      );
      const centerVsOuter = Math.max(
        0,
        Math.min(1, (outerLuma - centerLuma) / Math.max(outerLuma * 0.62, 22))
      );
      const defocusDrop =
        this.baselineGrad > 5
          ? Math.max(0, Math.min(0.4, (this.baselineGrad - meanGrad) / (this.baselineGrad * 0.75)))
          : 0;

      rawProximity =
        0.56 * relDrop + 0.29 * darkRatio + 0.15 * Math.max(centerVsOuter, defocusDrop);
    } else {
      // Dark room mode: phone screen fill-light reflects off close chest/face OR occludes residual light
      const biDelta = Math.min(1, Math.abs(centerLuma - this.baselineLuma) / 24);
      rawProximity = Math.max(biDelta, darkRatio * 0.75);
    }

    rawProximity = Math.max(0, Math.min(1, rawProximity));
    this.smoothedProximity = 0.62 * this.smoothedProximity + 0.38 * rawProximity;

    // Slow upper-envelope baseline drift compensation when resting cleanly in UP plank
    if (this.phase === 'UP' && this.smoothedProximity < thresholds.up * 0.75 && meanMotion < 3.5) {
      this.baselineLuma = 0.992 * this.baselineLuma + 0.008 * centerLuma;
      this.baselineGrad = 0.992 * this.baselineGrad + 0.008 * meanGrad;
    }

    this.advanceStateMachine(now, thresholds);
    this.emitTelemetry(true, null, centerLuma);
  }

  private advanceStateMachine(now: number, thresholds: { down: number; up: number }): void {
    const p = this.smoothedProximity;

    if (this.phase === 'UP') {
      if (p > thresholds.up + 0.08) {
        this.phase = 'DESCENDING';
        this.peakProximityInRep = p;
      }
    } else if (this.phase === 'DESCENDING') {
      this.peakProximityInRep = Math.max(this.peakProximityInRep, p);
      if (p >= thresholds.down) {
        this.phase = 'BOTTOM';
        this.bottomEnteredAt = now;
        this.callbacks.onBottomReached();
      } else if (p <= thresholds.up) {
        // Returned up without hitting required push-up depth (no rep!)
        this.phase = 'UP';
        this.peakProximityInRep = 0;
      }
    } else if (this.phase === 'BOTTOM') {
      this.peakProximityInRep = Math.max(this.peakProximityInRep, p);
      const heldMs = now - this.bottomEnteredAt;
      if (p <= thresholds.up) {
        // Ascended back to plank! Verify minimum bottom dwell (100ms) and human rep cadence (>=450ms)
        if (heldMs >= 95 && now - this.lastRepAt >= 450) {
          this.lastRepAt = now;
          const depthPct = Math.min(100, Math.round(this.peakProximityInRep * 100));
          this.phase = 'UP';
          this.peakProximityInRep = 0;
          this.callbacks.onRepCompleted(depthPct);
        } else {
          this.phase = 'UP';
          this.peakProximityInRep = 0;
        }
      }
    }
  }

  private emitTelemetry(cameraActive: boolean, error: string | null, centerLuma = this.baselineLuma): void {
    const thresholds = PRESET_THRESHOLDS[this.sensitivity];
    this.callbacks.onTelemetry({
      cameraActive,
      cameraError: error,
      phase: this.phase,
      proximity: this.smoothedProximity,
      downThreshold: thresholds.down,
      upThreshold: thresholds.up,
      baselineLuma: Math.round(this.baselineLuma),
      centerLuma: Math.round(centerLuma),
      isDarkAmbient: this.baselineLuma < 36,
      fps: this.fps,
    });
  }
}

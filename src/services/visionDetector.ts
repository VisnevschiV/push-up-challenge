import type { CameraPlacementMode, DepthRequirement } from './challengeStore';

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
}

export interface VisionCallbacks {
  onTelemetry: (telemetry: VisionTelemetry) => void;
  onBottomReached: () => void;
  onRepCompleted: () => void;
}

const W = 64;
const H = 48;

const DEPTH_THRESHOLDS: Record<DepthRequirement, { down: number; up: number }> = {
  easy: { down: 0.42, up: 0.2 },
  normal: { down: 0.58, up: 0.25 },
  strict: { down: 0.68, up: 0.28 },
};

export class FrontCameraPushUpDetector {
  private callbacks: VisionCallbacks;
  private stream: MediaStream | null = null;
  private videoEl: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private prevLuma: Float32Array = new Float32Array(W * H);

  private running = false;
  private isArmed = false;
  private depthReq: DepthRequirement = 'normal';
  private placementMode: CameraPlacementMode = 'both';

  private calibrationFrames = 0;
  private baselineLuma = 120;
  private baselineGrad = 12;
  private smoothedProximity = 0;
  private simulatedProximity: number | null = null;

  private phase: RepPhase = 'DISARMED';
  private bottomEnteredAt = 0;
  private lastRepAt = 0;
  private rafId: number | null = null;
  private lastAnalysisTs = 0;

  constructor(callbacks: VisionCallbacks) {
    this.callbacks = callbacks;
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  public configure(depthReq: DepthRequirement, placementMode: CameraPlacementMode): void {
    this.depthReq = depthReq;
    this.placementMode = placementMode;
  }

  public setArmed(armed: boolean): void {
    if (this.isArmed === armed) return;
    this.isArmed = armed;
    if (!armed) {
      this.phase = 'DISARMED';
    } else {
      this.recalibrate();
    }
  }

  public recalibrate(): void {
    this.calibrationFrames = 0;
    this.smoothedProximity = 0;
    this.phase = this.isArmed ? 'CALIBRATING' : 'DISARMED';
  }

  /** Triggers a clean simulated push-up cycle on desktop or when no camera is attached */
  public triggerSimulatedRep(): void {
    if (!this.isArmed) return;
    this.simulatedProximity = 0.82;
    if (this.phase === 'CALIBRATING') this.phase = 'UP';
    window.setTimeout(() => {
      this.simulatedProximity = 0.04;
      window.setTimeout(() => {
        this.simulatedProximity = null;
      }, 150);
    }, 180);
  }

  public async startCamera(videoElement: HTMLVideoElement): Promise<boolean> {
    this.videoEl = videoElement;
    this.running = true;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this.emitTelemetry(false, 'Camera API unavailable');
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
    } catch {
      this.emitTelemetry(false, 'Camera unavailable');
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
    if (now - this.lastAnalysisTs >= 30) {
      this.lastAnalysisTs = now;
      this.processFrame(now);
    }
    this.rafId = requestAnimationFrame(this.loop);
  };

  private processFrame(now: number): void {
    const thresholds = DEPTH_THRESHOLDS[this.depthReq];
    const hasLiveVideo =
      this.videoEl !== null &&
      this.stream !== null &&
      this.videoEl.readyState >= 2 &&
      this.videoEl.videoWidth > 0;

    if (this.simulatedProximity !== null) {
      if (this.phase === 'CALIBRATING') this.phase = 'UP';
      this.smoothedProximity = 0.45 * this.smoothedProximity + 0.55 * this.simulatedProximity;
      this.advanceStateMachine(now, thresholds);
      this.emitTelemetry(hasLiveVideo, hasLiveVideo ? null : 'Camera unavailable');
      return;
    }

    if (!hasLiveVideo || !this.ctx || !this.videoEl) {
      this.emitTelemetry(false, 'Camera unavailable');
      return;
    }

    this.ctx.drawImage(this.videoEl, 0, 0, W, H);
    const data = this.ctx.getImageData(0, 0, W, H).data;

    // Adjust ROI geometry based on Camera Placement Mode (Face vs Chest vs Hybrid Both)
    const roiMarginX = this.placementMode === 'face' ? 0.3 : this.placementMode === 'chest' ? 0.16 : 0.22;
    const roiMarginY = this.placementMode === 'face' ? 0.26 : this.placementMode === 'chest' ? 0.16 : 0.2;

    const xMin = Math.floor(W * roiMarginX);
    const xMax = Math.floor(W * (1 - roiMarginX));
    const yMin = Math.floor(H * roiMarginY);
    const yMax = Math.floor(H * (1 - roiMarginY));

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

        if (x >= xMin && x < xMax && y >= yMin && y < yMax) {
          innerSum += luma;
          innerCount++;
          if (luma < shadowCutoff) darkPixels++;
          motionSum += Math.abs(luma - this.prevLuma[pIdx]);
          if (x > xMin && y > yMin) {
            gradSum += Math.abs(luma - this.prevLuma[pIdx - 1]) + Math.abs(luma - this.prevLuma[pIdx - W]);
          }
        } else {
          outerSum += luma;
          outerCount++;
        }
        this.prevLuma[pIdx] = luma;
      }
    }

    const centerLuma = innerSum / Math.max(1, innerCount);
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

    if (this.calibrationFrames < 16) {
      this.phase = 'CALIBRATING';
      const alpha = this.calibrationFrames === 0 ? 1 : 0.24;
      this.baselineLuma = (1 - alpha) * this.baselineLuma + alpha * centerLuma;
      this.baselineGrad = (1 - alpha) * this.baselineGrad + alpha * meanGrad;
      this.calibrationFrames++;
      if (this.calibrationFrames >= 16) {
        this.phase = 'UP';
      }
      this.emitTelemetry(true, null, centerLuma);
      return;
    }

    const isDarkAmbient = this.baselineLuma < 36;
    let rawProximity = 0;

    if (!isDarkAmbient) {
      const relDrop = Math.max(
        0,
        Math.min(1, (this.baselineLuma - centerLuma) / Math.max(this.baselineLuma * 0.56, 20))
      );
      const ringContrast = Math.max(
        0,
        Math.min(1, (outerLuma - centerLuma) / Math.max(outerLuma * 0.6, 22))
      );
      const defocusDrop =
        this.baselineGrad > 5
          ? Math.max(0, Math.min(0.42, (this.baselineGrad - meanGrad) / (this.baselineGrad * 0.72)))
          : 0;

      const shadowWeight = this.placementMode === 'chest' ? 0.62 : 0.54;
      const darkWeight = this.placementMode === 'face' ? 0.34 : 0.28;
      const detailWeight = 1 - shadowWeight - darkWeight;

      rawProximity =
        shadowWeight * relDrop +
        darkWeight * darkRatio +
        detailWeight * Math.max(ringContrast, defocusDrop);
    } else {
      const biDelta = Math.min(1, Math.abs(centerLuma - this.baselineLuma) / 24);
      rawProximity = Math.max(biDelta, darkRatio * 0.75);
    }

    rawProximity = Math.max(0, Math.min(1, rawProximity));
    this.smoothedProximity = 0.6 * this.smoothedProximity + 0.4 * rawProximity;

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
      if (p > thresholds.up + 0.07) {
        this.phase = 'DESCENDING';
      }
    } else if (this.phase === 'DESCENDING') {
      if (p >= thresholds.down) {
        this.phase = 'BOTTOM';
        this.bottomEnteredAt = now;
        this.callbacks.onBottomReached();
      } else if (p <= thresholds.up) {
        this.phase = 'UP';
      }
    } else if (this.phase === 'BOTTOM') {
      const heldMs = now - this.bottomEnteredAt;
      if (p <= thresholds.up) {
        if (heldMs >= 90 && now - this.lastRepAt >= 430) {
          this.lastRepAt = now;
          this.phase = 'UP';
          this.callbacks.onRepCompleted();
        } else {
          this.phase = 'UP';
        }
      }
    }
  }

  private emitTelemetry(
    cameraActive: boolean,
    error: string | null,
    centerLuma = this.baselineLuma
  ): void {
    const thresholds = DEPTH_THRESHOLDS[this.depthReq];
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
    });
  }
}

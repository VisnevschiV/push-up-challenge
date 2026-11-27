import React, { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChallengeState,
  PrescribedWorkout,
  SessionMode,
} from '../services/challengeStore';
import {
  computeDashboardMetrics,
  formatSetsLabel,
} from '../services/challengeStore';
import type { OrientationSnapshot } from '../services/orientationSensor';
import { GroundOrientationMonitor } from '../services/orientationSensor';
import type { VisionTelemetry } from '../services/visionDetector';
import { FrontCameraPushUpDetector } from '../services/visionDetector';
import { soundEngine } from '../services/sound';

interface TrainViewProps {
  state: ChallengeState;
  todayProgramWorkout: PrescribedWorkout;
  launchRequest: { mode: SessionMode; programWorkout?: PrescribedWorkout } | null;
  onConsumeLaunchRequest: () => void;
  orientationMonitor: GroundOrientationMonitor;
  orientation: OrientationSnapshot;
  onWorkoutScreenChange: (active: boolean) => void;
  onToggleMute: () => void;
  onSetInitialBaselineMax: (maxReps: number) => void;
  onCompleteWorkout: (payload: {
    mode: SessionMode;
    totalReps: number;
    setsCompleted?: number[];
    durationSec: number;
    programDay?: number;
  }) => string | null;
}

type Stage = 'home' | 'active' | 'summary';

export const TrainView: React.FC<TrainViewProps> = ({
  state,
  todayProgramWorkout,
  launchRequest,
  onConsumeLaunchRequest,
  orientationMonitor,
  orientation,
  onWorkoutScreenChange,
  onToggleMute,
  onSetInitialBaselineMax,
  onCompleteWorkout,
}) => {
  const needsBaseline = state.baselineMax === null;
  const [selectedMode, setSelectedMode] = useState<SessionMode>(
    needsBaseline ? 'max_test' : 'program'
  );
  const [activeWorkoutPlan, setActiveWorkoutPlan] =
    useState<PrescribedWorkout>(todayProgramWorkout);
  const [manualBaselineDraft, setManualBaselineDraft] = useState(5);

  const [stage, setStage] = useState<Stage>('home');
  const [currentSetIdx, setCurrentSetIdx] = useState(0);
  const [completedSets, setCompletedSets] = useState<number[]>([]);
  const [setReps, setSetReps] = useState(0);
  const [restRemaining, setRestRemaining] = useState<number | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [repPulse, setRepPulse] = useState(false);
  const [summaryFeedback, setSummaryFeedback] = useState<string | null>(null);
  const [summaryTotalReps, setSummaryTotalReps] = useState(0);
  const [summarySets, setSummarySets] = useState<number[]>([]);

  const [telemetry, setTelemetry] = useState<VisionTelemetry>({
    cameraActive: false,
    cameraError: 'Camera unavailable',
    phase: 'DISARMED',
    readyCountdownSec: 0,
    activeMethod: 'CALIBRATING',
    mediapipeReady: false,
    faceBox: null,
    proximity: 0,
    downThreshold: 0.55,
    upThreshold: 0.24,
    baselineLuma: 120,
    centerLuma: 120,
    isDarkAmbient: false,
  });

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const detectorRef = useRef<FrontCameraPushUpDetector | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const prevFlatRef = useRef(false);

  // Refs to read latest state inside detector callback without stale closures
  const modeRef = useRef<SessionMode>(selectedMode);
  const setIdxRef = useRef(0);
  const setRepsRef = useRef(0);
  const restRef = useRef<number | null>(null);
  const planRef = useRef<PrescribedWorkout>(activeWorkoutPlan);
  const completedSetsRef = useRef<number[]>([]);

  useEffect(() => {
    modeRef.current = selectedMode;
  }, [selectedMode]);
  useEffect(() => {
    setIdxRef.current = currentSetIdx;
  }, [currentSetIdx]);
  useEffect(() => {
    setRepsRef.current = setReps;
  }, [setReps]);
  useEffect(() => {
    restRef.current = restRemaining;
  }, [restRemaining]);
  const effectiveWorkoutPlan = stage === 'home' ? todayProgramWorkout : activeWorkoutPlan;

  useEffect(() => {
    planRef.current = effectiveWorkoutPlan;
  }, [effectiveWorkoutPlan]);

  // Sync audio & speech flags
  useEffect(() => {
    soundEngine.soundEnabled = state.settings.soundEnabled;
    soundEngine.spokenEnabled = state.settings.spokenEnabled;
  }, [state.settings.soundEnabled, state.settings.spokenEnabled]);

  // Sync detector thresholds live
  useEffect(() => {
    detectorRef.current?.configure(
      state.settings.depthRequirement,
      state.settings.placementMode
    );
  }, [state.settings.depthRequirement, state.settings.placementMode]);

  // Arm/disarm camera detector based on flat ground check & rest timer
  useEffect(() => {
    if (stage === 'active') {
      if (orientation.isFlatLocked && !prevFlatRef.current) {
        soundEngine.playFlatLocked();
        soundEngine.speak('Floor locked. Get into plank.');
      }
      const shouldArm = orientation.isFlatLocked && restRemaining === null;
      detectorRef.current?.setArmed(shouldArm);
    }
    prevFlatRef.current = orientation.isFlatLocked;
  }, [orientation.isFlatLocked, restRemaining, stage]);

  // Elapsed workout timer
  useEffect(() => {
    if (stage !== 'active') return;
    const id = window.setInterval(() => {
      setElapsedSec((s) => s + 1);
    }, 1000);
    return () => window.clearInterval(id);
  }, [stage]);

  // Between-set rest countdown timer
  useEffect(() => {
    if (stage !== 'active' || restRemaining === null) return;
    const id = window.setTimeout(() => {
      if (restRemaining <= 1) {
        setRestRemaining(null);
        soundEngine.playRestFinished();
      } else {
        if (restRemaining === 6) {
          soundEngine.speak('5 seconds. Get in plank.');
        }
        setRestRemaining((r) => (r !== null ? r - 1 : null));
      }
    }, 1000);
    return () => window.clearTimeout(id);
  }, [stage, restRemaining]);

  const acquireWakeLock = async () => {
    if ('wakeLock' in navigator) {
      try {
        wakeLockRef.current = await navigator.wakeLock.request('screen');
      } catch {
        // Ignore WakeLock errors in restricted environments
      }
    }
  };

  const stopHardware = useCallback(() => {
    detectorRef.current?.stop();
    detectorRef.current = null;
    if (wakeLockRef.current) {
      wakeLockRef.current.release().catch(() => {});
      wakeLockRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => stopHardware();
  }, [stopHardware]);

  const handleRepDetected = useCallback(() => {
    if (restRef.current !== null) return;

    const nextRep = setRepsRef.current + 1;
    setRepsRef.current = nextRep;
    setSetReps(nextRep);
    setRepPulse(true);
    window.setTimeout(() => setRepPulse(false), 200);

    const mode = modeRef.current;
    const plan = planRef.current;

    if (mode === 'program' && plan.sets.length > 0) {
      const idx = setIdxRef.current;
      const targetForThisSet = plan.sets[idx] ?? 1;
      const isLastSet = idx >= plan.sets.length - 1;

      if (!isLastSet && nextRep >= targetForThisSet) {
        // Set completed! Advance to auto-rest before next set
        const updatedSets = [...completedSetsRef.current, nextRep];
        completedSetsRef.current = updatedSets;
        setCompletedSets(updatedSets);
        setSetReps(0);
        setRepsRef.current = 0;
        setCurrentSetIdx(idx + 1);
        setIdxRef.current = idx + 1;
        setRestRemaining(plan.restSeconds);
        restRef.current = plan.restSeconds;
        soundEngine.playRepCounted(
          nextRep,
          `Set ${idx + 1} complete. Rest ${plan.restSeconds} seconds.`,
          true
        );
        return;
      }

      if (isLastSet && nextRep === targetForThisSet) {
        soundEngine.playRepCounted(
          nextRep,
          `${nextRep}! Target hit, keep going for bonus reps!`,
          true
        );
        return;
      }
    }

    soundEngine.playRepCounted(nextRep);
  }, []);

  const startSession = useCallback(
    async (modeToRun: SessionMode, customWorkout?: PrescribedWorkout) => {
      const chosenPlan = customWorkout ?? todayProgramWorkout;
      setSelectedMode(modeToRun);
      modeRef.current = modeToRun;
      setActiveWorkoutPlan(chosenPlan);
      planRef.current = chosenPlan;

      soundEngine.unlock();
      await orientationMonitor.requestAndStart();
      await acquireWakeLock();

      setCurrentSetIdx(0);
      setIdxRef.current = 0;
      setCompletedSets([]);
      completedSetsRef.current = [];
      setSetReps(0);
      setRepsRef.current = 0;
      setRestRemaining(null);
      restRef.current = null;
      setElapsedSec(0);
      setStage('active');
      onWorkoutScreenChange(true);

      const detector = new FrontCameraPushUpDetector({
        onTelemetry: (t) => setTelemetry(t),
        onReadyComplete: () => soundEngine.speak('Ready. Go!'),
        onBottomReached: () => soundEngine.playBottomDepth(),
        onRepCompleted: handleRepDetected,
      });
      detector.configure(
        state.settings.depthRequirement,
        state.settings.placementMode
      );
      detector.setArmed(orientationMonitor.getSnapshot().isFlatLocked);
      detectorRef.current = detector;

      requestAnimationFrame(() => {
        if (videoRef.current) {
          detector.startCamera(videoRef.current);
        }
      });
    },
    [
      handleRepDetected,
      onWorkoutScreenChange,
      orientationMonitor,
      state.settings.depthRequirement,
      state.settings.placementMode,
      todayProgramWorkout,
    ]
  );

  // Handle direct workout launch from 30-Day or Setup tab
  useEffect(() => {
    if (!launchRequest) return;
    const { mode, programWorkout } = launchRequest;
    const id = window.setTimeout(() => {
      onConsumeLaunchRequest();
      startSession(mode, programWorkout);
    }, 0);
    return () => window.clearTimeout(id);
  }, [launchRequest, onConsumeLaunchRequest, startSession]);

  // Keyboard Spacebar simulation on desktop
  useEffect(() => {
    if (stage !== 'active') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        if (!orientationMonitor.getSnapshot().isFlatLocked) {
          orientationMonitor.setManualFlatOverride(true);
        }
        detectorRef.current?.triggerSimulatedRep();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [stage, orientationMonitor]);

  const handleExitWithoutSaving = () => {
    stopHardware();
    setStage('home');
    onWorkoutScreenChange(false);
  };

  const handleSaveAndFinish = () => {
    stopHardware();
    onWorkoutScreenChange(false);

    const finalSets =
      selectedMode === 'program'
        ? setReps > 0 || completedSets.length < activeWorkoutPlan.sets.length
          ? [...completedSets, ...(setReps > 0 ? [setReps] : [])]
          : completedSets
        : [setReps];

    const total = finalSets.reduce((a, b) => a + b, 0);
    if (total === 0) {
      setStage('home');
      return;
    }

    const feedback = onCompleteWorkout({
      mode: selectedMode,
      totalReps: total,
      setsCompleted: finalSets,
      durationSec: Math.max(1, elapsedSec),
      programDay:
        selectedMode === 'program' ? activeWorkoutPlan.dayNumber : undefined,
    });

    setSummaryTotalReps(total);
    setSummarySets(finalSets);
    setSummaryFeedback(feedback);
    setStage('summary');
  };

  const metrics = computeDashboardMetrics(state);
  const formatClock = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  // --- STAGE: POST-WORKOUT SUMMARY ---
  if (stage === 'summary') {
    return (
      <section className="card" style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <span className="card-label">
          {selectedMode === 'max_test'
            ? 'BASELINE MAX RECORDED'
            : selectedMode === 'program'
              ? `PROGRAM DAY ${activeWorkoutPlan.dayNumber} LOGGED`
              : 'SESSION SAVED'}
        </span>

        <div className="big-rep-counter" style={{ margin: '4px 0', color: 'var(--lime)' }}>
          {summaryTotalReps}
        </div>

        {summarySets.length > 1 && (
          <div className="mono-num" style={{ fontSize: '0.88rem', color: 'var(--text-secondary)' }}>
            Sets completed: {summarySets.join(' · ')}
          </div>
        )}

        {summaryFeedback && (
          <div
            style={{
              background: 'var(--lime-tint)',
              border: '1px solid var(--lime-border)',
              borderRadius: 14,
              padding: '12px 16px',
              fontSize: '0.88rem',
              color: 'var(--text-primary)',
            }}
          >
            {summaryFeedback}
          </div>
        )}

        <button
          type="button"
          id="btn-summary-continue"
          className="cta-lime"
          onClick={() => setStage('home')}
        >
          Continue
        </button>
      </section>
    );
  }

  // --- STAGE: ACTIVE WORKOUT HUD (Matching image_2.png) ---
  if (stage === 'active') {
    const modeTitle =
      selectedMode === 'max_test'
        ? 'Max-Rep Baseline Test'
        : selectedMode === 'program'
          ? `Day ${activeWorkoutPlan.dayNumber} · Set ${Math.min(
              currentSetIdx + 1,
              activeWorkoutPlan.sets.length
            )}/${activeWorkoutPlan.sets.length}`
          : 'Daily Target Set';

    const currentSetTarget =
      selectedMode === 'program'
        ? activeWorkoutPlan.sets[currentSetIdx] ?? 5
        : selectedMode === 'daily'
          ? Math.max(1, metrics.remainingToday || metrics.dailyGoal)
          : 0;

    const isLastProgramSet =
      selectedMode === 'program' &&
      currentSetIdx === activeWorkoutPlan.sets.length - 1;

    const proxPct = Math.min(100, Math.round(telemetry.proximity * 100));
    const threshPct = Math.round(telemetry.downThreshold * 100);
    const isBottom =
      telemetry.phase === 'BOTTOM' || telemetry.proximity >= telemetry.downThreshold;

    // Bullseye bubble offset
    const maxDeg = 30;
    const dotX =
      (Math.max(-maxDeg, Math.min(maxDeg, orientation.gamma)) / maxDeg) * 20;
    const dotY =
      (Math.max(-maxDeg, Math.min(maxDeg, orientation.beta)) / maxDeg) * 20;

    const statusLine = !orientation.isFlatLocked
      ? !orientation.isFaceUp
        ? 'FLIP PHONE FACE-UP'
        : 'PLACE PHONE FLAT ON FLOOR'
      : telemetry.phase === 'GET_READY'
        ? `GET INTO PLANK · ${telemetry.readyCountdownSec}S`
        : telemetry.phase === 'CALIBRATING'
          ? 'ZEROING PLANK BASELINE...'
          : isBottom
            ? 'DEPTH HIT · PUSH UP!'
            : telemetry.phase === 'DESCENDING'
              ? 'KEEP LOWERING...'
              : 'READY · DESCEND OVER LENS';

    const activeMethodLabel =
      telemetry.activeMethod === 'BLAZEFACE'
        ? 'BLAZEFACE 3D SCALE'
        : telemetry.activeMethod === 'LOOMING_FLOW'
          ? 'RADIAL LOOMING FLOW'
          : telemetry.activeMethod === 'OCCLUSION'
            ? 'GAIN-INVARIANT OCCLUSION'
            : 'PLANK CALIBRATION';

    return (
      <div id="active-workout-screen">
        {/* Top Action Bar */}
        <div className="workout-top-bar">
          <button
            type="button"
            id="btn-exit-workout"
            className="btn-outline"
            onClick={handleExitWithoutSaving}
          >
            ✕ Exit
          </button>

          <div style={{ textAlign: 'center' }}>
            <div style={{ fontWeight: 700, fontSize: '0.92rem' }}>{modeTitle}</div>
            <div
              className="mono-num"
              style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}
            >
              {formatClock(elapsedSec)}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              id="btn-mute-toggle"
              className="btn-outline"
              style={{ padding: '9px 11px' }}
              onClick={onToggleMute}
              aria-label="Toggle sound"
            >
              {state.settings.soundEnabled ? '🔊' : '🔇'}
            </button>
            <button
              type="button"
              id="btn-save-workout"
              className="btn-outline"
              onClick={handleSaveAndFinish}
            >
              ✓ Save
            </button>
          </div>
        </div>

        {/* Flat Floor Placement Banner */}
        {!orientation.isFlatLocked ? (
          <div className="amber-banner">
            <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
              <span
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: '50%',
                  background: 'var(--amber)',
                  flexShrink: 0,
                }}
              />
              <div>
                <div style={{ fontWeight: 700, fontSize: '0.88rem' }}>
                  Waiting for Flat Floor Placement
                </div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                  {!orientation.hasHardwareEvents
                    ? 'No mobile motion sensor detected — tap Sim Floor to test on desktop'
                    : !orientation.isFaceUp
                      ? 'Phone is upside down — flip screen & front camera up'
                      : `Tilt ${orientation.tiltDeg.toFixed(1)}° — lay flat within ${state.settings.flatToleranceDeg}°`}
                </div>
              </div>
            </div>

            <button
              type="button"
              id="btn-sim-floor"
              className="btn-outline"
              style={{ flexShrink: 0, padding: '7px 12px', fontSize: '0.79rem' }}
              onClick={() => orientationMonitor.setManualFlatOverride(true)}
            >
              Sim Floor
            </button>
          </div>
        ) : (
          <div className="armed-banner">
            <span style={{ color: 'var(--lime)', fontWeight: 700 }}>
              ● Floor Lock Active · {activeMethodLabel}
            </span>
            {orientation.manualFlatOverride ? (
              <button
                type="button"
                onClick={() => orientationMonitor.setManualFlatOverride(false)}
                style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', textDecoration: 'underline' }}
              >
                Exit Sim Floor
              </button>
            ) : (
              <span className="mono-num" style={{ color: 'var(--text-secondary)', fontSize: '0.76rem' }}>
                Tilt {orientation.tiltDeg.toFixed(1)}°
              </span>
            )}
          </div>
        )}

        {/* Main Center Counter or Auto-Rest Card */}
        <div className="workout-main-card">
          {selectedMode === 'program' && (
            <div className="set-chips-row">
              {activeWorkoutPlan.sets.map((sTarget, idx) => {
                const isDone = idx < completedSets.length;
                const isCurr = idx === currentSetIdx && restRemaining === null;
                const label =
                  idx === activeWorkoutPlan.sets.length - 1
                    ? `${sTarget}+`
                    : String(sTarget);
                return (
                  <span
                    key={idx}
                    className={`set-chip ${isDone ? 'done' : ''} ${isCurr ? 'current' : ''}`}
                  >
                    {isDone ? `✓ ${completedSets[idx]}` : `S${idx + 1}: ${label}`}
                  </span>
                );
              })}
            </div>
          )}

          {restRemaining !== null ? (
            /* Hands-free between-set Rest Timer */
            <div style={{ padding: '10px 0', width: '100%' }}>
              <span className="card-label" style={{ color: 'var(--lime)' }}>
                SET {currentSetIdx} COMPLETE · AUTO-REST
              </span>
              <div className="big-rep-counter">{formatClock(restRemaining)}</div>
              <div style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: 18 }}>
                Up next: <strong>Set {currentSetIdx + 1}</strong> —{' '}
                <strong>
                  {activeWorkoutPlan.sets[currentSetIdx]}
                  {currentSetIdx === activeWorkoutPlan.sets.length - 1 ? '+' : ''} reps
                </strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'center', gap: 10 }}>
                <button
                  type="button"
                  className="btn-outline"
                  onClick={() => setRestRemaining((r) => (r ?? 0) + 15)}
                >
                  +15s Rest
                </button>
                <button
                  type="button"
                  id="btn-skip-rest"
                  className="cta-lime"
                  style={{ width: 'auto', padding: '10px 20px', fontSize: '0.88rem' }}
                  onClick={() => {
                    setRestRemaining(null);
                    soundEngine.playRestFinished();
                  }}
                >
                  Start Next Set Now →
                </button>
              </div>
            </div>
          ) : (
            <>
              <div
                className={`big-rep-counter ${repPulse ? 'pulse' : ''}`}
                id="live-rep-number"
              >
                {telemetry.phase === 'GET_READY'
                  ? `${telemetry.readyCountdownSec}`
                  : setReps}
              </div>

              <div className="status-caps">{statusLine}</div>

              <div
                style={{
                  fontSize: '0.86rem',
                  color: 'var(--text-secondary)',
                  marginTop: 8,
                }}
              >
                {telemetry.phase === 'GET_READY'
                  ? 'Step into straight-arm plank over the phone before zeroing'
                  : selectedMode === 'max_test'
                    ? 'Do as many clean unbroken push-ups as you can — tap Save when done'
                    : selectedMode === 'program'
                      ? `Target: ${currentSetTarget}${isLastProgramSet ? '+ (AMRAP)' : ''} reps`
                      : `Target: ${currentSetTarget} reps`}
              </div>

              <div className="proximity-bar-wrap">
                <div
                  className="mono-num"
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: '0.72rem',
                    color: 'var(--text-secondary)',
                  }}
                >
                  <span>DEPTH ({activeMethodLabel})</span>
                  <span>
                    {proxPct}% / {threshPct}% TARGET
                  </span>
                </div>
                <div className="proximity-track">
                  <div
                    className={`proximity-fill ${isBottom ? 'hit' : ''}`}
                    style={{ width: `${proxPct}%` }}
                  />
                  <div
                    className="proximity-target-line"
                    style={{ left: `${threshPct}%` }}
                  />
                </div>
              </div>

              <button
                type="button"
                id="btn-simulate-rep"
                className="btn-outline"
                style={{ marginTop: 18, padding: '11px 18px' }}
                onClick={() => {
                  if (!orientation.isFlatLocked) {
                    orientationMonitor.setManualFlatOverride(true);
                  }
                  setTimeout(() => {
                    detectorRef.current?.triggerSimulatedRep();
                  }, 30);
                }}
              >
                {telemetry.cameraActive
                  ? 'Tap to Test Rep (+1)'
                  : 'Simulate Push-Up Rep (No Camera Detected)'}
              </button>
            </>
          )}
        </div>

        {/* Bottom 2-Column Split Sensor Cards */}
        <div className="sensor-split-grid">
          <div className="sensor-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="card-label">FLOOR LEVEL</span>
              <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>📱</span>
            </div>

            <div className="floor-bullseye">
              <div
                className={`floor-bullseye-ring ${orientation.isFlatLocked ? 'locked' : ''}`}
              />
              <div
                className={`floor-dot ${orientation.isFlatLocked ? 'locked' : ''}`}
                style={{
                  transform: `translate(${dotX.toFixed(1)}px, ${dotY.toFixed(1)}px)`,
                }}
              />
            </div>

            <div
              className="mono-num"
              style={{
                textAlign: 'center',
                fontSize: '0.7rem',
                color: orientation.isFlatLocked ? 'var(--lime)' : 'var(--text-secondary)',
              }}
            >
              {orientation.manualFlatOverride
                ? 'SIMULATED FLAT'
                : !orientation.hasHardwareEvents
                  ? 'DESKTOP / NO IMU'
                  : orientation.isFlatLocked
                    ? `LOCKED · ${orientation.tiltDeg.toFixed(1)}°`
                    : `TILT ${orientation.tiltDeg.toFixed(1)}°`}
            </div>
          </div>

          <div className="sensor-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="card-label">FRONT CAM CV</span>
              <button
                type="button"
                id="btn-zero-camera"
                onClick={() => detectorRef.current?.recalibrate(true)}
                className="mono-num"
                style={{ fontSize: '0.73rem', color: 'var(--lime)', fontWeight: 700 }}
              >
                ↻ Zero
              </button>
            </div>

            <div className="cam-preview-box">
              <video
                ref={videoRef}
                className="cam-video"
                playsInline
                muted
                style={{ display: telemetry.cameraActive ? 'block' : 'none' }}
              />
              {telemetry.cameraActive && telemetry.faceBox && (
                <div
                  style={{
                    position: 'absolute',
                    left: `${Math.max(0, (1 - telemetry.faceBox.x - telemetry.faceBox.w) * 100)}%`,
                    top: `${telemetry.faceBox.y * 100}%`,
                    width: `${telemetry.faceBox.w * 100}%`,
                    height: `${telemetry.faceBox.h * 100}%`,
                    border: '2px solid var(--lime)',
                    borderRadius: 6,
                    pointerEvents: 'none',
                  }}
                />
              )}
              {!telemetry.cameraActive && (
                <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.76rem' }}>
                  <div style={{ fontSize: '1.1rem', marginBottom: 3 }}>📷</div>
                  Camera unavailable
                </div>
              )}
            </div>

            <div
              className="mono-num"
              style={{
                textAlign: 'center',
                fontSize: '0.68rem',
                color:
                  telemetry.activeMethod === 'BLAZEFACE'
                    ? 'var(--lime)'
                    : 'var(--text-secondary)',
              }}
            >
              {telemetry.cameraActive
                ? `${activeMethodLabel}`
                : 'DEMO FALLBACK ACTIVE'}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // --- STAGE: HOME TRAIN VIEW (Matching image.png + Baseline Max Onboarding) ---
  const ringRadius = 31;
  const ringCirc = 2 * Math.PI * ringRadius;
  const ringOffset = ringCirc * (1 - metrics.todayPct / 100);
  const placementLabel =
    state.settings.placementMode === 'both'
      ? 'HYBRID'
      : state.settings.placementMode.toUpperCase();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* First-Time Baseline Max Prompt */}
      {needsBaseline && (
        <section
          className="card"
          id="onboarding-max-card"
          style={{
            borderColor: 'var(--lime-border)',
            background: 'linear-gradient(180deg, rgba(200,249,40,0.08) 0%, var(--bg-card) 100%)',
          }}
        >
          <span className="card-label" style={{ color: 'var(--lime)' }}>
            STEP 1 · PERSONALIZE YOUR PROGRAM
          </span>
          <h2 style={{ margin: '6px 0 6px', fontSize: '1.2rem', fontWeight: 800 }}>
            Test Your Max Pushups First
          </h2>
          <p style={{ margin: '0 0 16px', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            Place your phone flat on the floor and do <strong>1 max-effort unbroken set</strong>.
            We&apos;ll calculate your custom 5-set progression (e.g.{' '}
            <span className="mono-num">3 · 4 · 3 · 3 · 4+</span>) and milestone goal from there.
          </p>

          <button
            type="button"
            id="btn-start-baseline-test"
            className="cta-lime"
            onClick={() => startSession('max_test')}
          >
            ▶ Do My Baseline Max Test
          </button>

          <div
            style={{
              marginTop: 14,
              paddingTop: 12,
              borderTop: '1px solid var(--border-card)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              flexWrap: 'wrap',
            }}
          >
            <span style={{ fontSize: '0.79rem', color: 'var(--text-secondary)' }}>
              Already know your max?
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div className="stepper-box">
                <button
                  type="button"
                  className="stepper-btn"
                  onClick={() => setManualBaselineDraft((v) => Math.max(1, v - 1))}
                >
                  −
                </button>
                <span className="mono-num" style={{ minWidth: 28, textAlign: 'center', fontWeight: 700 }}>
                  {manualBaselineDraft}
                </span>
                <button
                  type="button"
                  className="stepper-btn"
                  onClick={() => setManualBaselineDraft((v) => v + 1)}
                >
                  +
                </button>
              </div>
              <button
                type="button"
                id="btn-set-known-max"
                className="btn-outline"
                style={{ padding: '7px 12px', fontSize: '0.8rem' }}
                onClick={() => {
                  onSetInitialBaselineMax(manualBaselineDraft);
                  setSelectedMode('program');
                }}
              >
                Build Plan
              </button>
            </div>
          </div>
        </section>
      )}

      {/* Card 1: Today's Push-Ups + Progress Ring + Clear Goal */}
      <section className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <span className="card-label">TODAY&apos;S PUSH-UPS</span>
            <div style={{ marginTop: 6, display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span
                className="mono-num"
                style={{ fontSize: '2.9rem', fontWeight: 700, lineHeight: 1 }}
              >
                {metrics.todayReps}
              </span>
              <span
                className="mono-num"
                style={{ fontSize: '1.15rem', color: 'var(--text-secondary)' }}
              >
                / {metrics.dailyGoal}
              </span>
            </div>
            <div style={{ fontSize: '0.84rem', color: 'var(--text-secondary)', marginTop: 8 }}>
              {metrics.remainingToday === 0
                ? "Today's daily goal locked in!"
                : `${metrics.remainingToday} more reps to lock today's goal`}
            </div>
          </div>

          {/* Circular Progress Ring */}
          <div style={{ position: 'relative', width: 76, height: 76, flexShrink: 0 }}>
            <svg width="76" height="76" viewBox="0 0 76 76" style={{ transform: 'rotate(-90deg)' }}>
              <circle
                cx="38"
                cy="38"
                r={ringRadius}
                fill="none"
                stroke="#20252b"
                strokeWidth="6.5"
              />
              <circle
                cx="38"
                cy="38"
                r={ringRadius}
                fill="none"
                stroke="var(--lime)"
                strokeWidth="6.5"
                strokeLinecap="round"
                strokeDasharray={ringCirc}
                strokeDashoffset={ringOffset}
                style={{ transition: 'stroke-dashoffset 0.3s ease' }}
              />
            </svg>
            <div
              className="mono-num"
              style={{
                position: 'absolute',
                inset: 0,
                display: 'grid',
                placeItems: 'center',
                fontSize: '0.82rem',
                fontWeight: 700,
              }}
            >
              {metrics.todayPct}%
            </div>
          </div>
        </div>

        {/* 3 Mini Stat Boxes */}
        <div className="mini-stats-grid" style={{ marginTop: 18 }}>
          <div className="mini-stat-box">
            <div className="mini-stat-val">{metrics.bestSetPR}</div>
            <div className="mini-stat-lbl">Max Set PR</div>
          </div>
          <div className="mini-stat-box">
            <div className="mini-stat-val">{metrics.totalLifetimeReps}</div>
            <div className="mini-stat-lbl">Lifetime</div>
          </div>
          <div className="mini-stat-box">
            <div className="mini-stat-val" style={{ color: 'var(--lime)' }}>
              {metrics.milestoneGoal}
            </div>
            <div className="mini-stat-lbl">Max Goal</div>
          </div>
        </div>
      </section>

      {/* Card 2: Choose Session Mode */}
      <section className="card">
        <span className="card-label" style={{ display: 'block', marginBottom: 14 }}>
          CHOOSE SESSION MODE
        </span>

        <div className="mode-list">
          {/* Guided 5-Set Adaptive Program */}
          <button
            type="button"
            id="mode-select-program"
            className={`mode-card ${selectedMode === 'program' ? 'selected' : ''}`}
            onClick={() => setSelectedMode('program')}
          >
            <div className="mode-icon-box">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="12 2 2 7 12 12 22 7 12 2" />
                <polyline points="2 12 12 17 22 12" />
                <polyline points="2 17 12 22 22 17" />
              </svg>
            </div>
            <div className="mode-info">
              <div className="mode-title">
                Adaptive Program · Day {todayProgramWorkout.dayNumber}
              </div>
              <div className="mode-sub">
                Guided sets ({formatSetsLabel(todayProgramWorkout.sets)}) with{' '}
                {todayProgramWorkout.restSeconds}s auto-rest
              </div>
            </div>
            <span className="mode-badge">{todayProgramWorkout.totalMinReps}+ reps</span>
          </button>

          {/* Daily Goal Accumulator */}
          <button
            type="button"
            id="mode-select-daily"
            className={`mode-card ${selectedMode === 'daily' ? 'selected' : ''}`}
            onClick={() => setSelectedMode('daily')}
          >
            <div className="mode-icon-box">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="9" />
                <circle cx="12" cy="12" r="5" />
                <circle cx="12" cy="12" r="1.5" fill="currentColor" />
              </svg>
            </div>
            <div className="mode-info">
              <div className="mode-title">Daily Goal Accumulator</div>
              <div className="mode-sub">
                Knock out sets at your own pace toward {metrics.dailyGoal}/day
              </div>
            </div>
            <span className="mode-badge">{metrics.remainingToday} left</span>
          </button>

          {/* Max-Rep Test (AMRAP) */}
          <button
            type="button"
            id="mode-select-max"
            className={`mode-card ${selectedMode === 'max_test' ? 'selected' : ''}`}
            onClick={() => setSelectedMode('max_test')}
          >
            <div className="mode-icon-box">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
              </svg>
            </div>
            <div className="mode-info">
              <div className="mode-title">Max-Rep Test (AMRAP)</div>
              <div className="mode-sub">
                Single unbroken set to test &amp; update your ceiling
              </div>
            </div>
            <span className="mode-badge">PR {metrics.bestSetPR}</span>
          </button>
        </div>

        <button
          type="button"
          id="btn-place-phone-start"
          className="cta-lime"
          style={{ marginTop: 18 }}
          onClick={() => startSession(selectedMode)}
        >
          ▶ Place Phone on Floor &amp; Start
        </button>

        <div
          style={{
            textAlign: 'center',
            fontSize: '0.76rem',
            color: 'var(--text-secondary)',
            marginTop: 12,
          }}
        >
          Mode: <strong style={{ color: 'var(--text-primary)' }}>{placementLabel}</strong> · Set
          phone flat face-up under your face or chest
        </div>
      </section>
    </div>
  );
};

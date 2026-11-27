import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ChallengeState,
  PrescribedWorkout,
  SessionMode,
  UserSettings,
} from './services/challengeStore';
import {
  build30DayProgram,
  computeDashboardMetrics,
  evaluateProgramProgression,
  loadChallengeState,
  saveChallengeState,
  toLocalDateKey,
} from './services/challengeStore';
import type { OrientationSnapshot } from './services/orientationSensor';
import { GroundOrientationMonitor } from './services/orientationSensor';
import { TrainView } from './components/TrainView';
import { Program30View } from './components/Program30View';
import { StatsView } from './components/StatsView';
import type { BeforeInstallPromptEvent } from './components/SetupView';
import { SetupView } from './components/SetupView';

type TabId = 'train' | 'program' | 'stats' | 'setup';

export function App() {
  const [state, setState] = useState<ChallengeState>(() => loadChallengeState());
  const [activeTab, setActiveTab] = useState<TabId>('train');
  const [workoutFullscreen, setWorkoutFullscreen] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [launchRequest, setLaunchRequest] = useState<{
    mode: SessionMode;
    programWorkout?: PrescribedWorkout;
  } | null>(null);

  const orientationMonitor = useMemo(() => new GroundOrientationMonitor(), []);
  const [orientation, setOrientation] = useState<OrientationSnapshot>(() =>
    orientationMonitor.getSnapshot()
  );

  useEffect(() => {
    saveChallengeState(state);
  }, [state]);

  useEffect(() => {
    orientationMonitor.setToleranceDeg(state.settings.flatToleranceDeg);
  }, [orientationMonitor, state.settings.flatToleranceDeg]);

  useEffect(() => {
    const unsub = orientationMonitor.subscribe((snap) => setOrientation(snap));
    if (!orientationMonitor.needsExplicitPermissionGesture()) {
      orientationMonitor.startListening();
    }
    return () => {
      unsub();
      orientationMonitor.stopListening();
    };
  }, [orientationMonitor]);

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const schedule = useMemo(() => build30DayProgram(state), [state]);
  const todayProgramWorkout = useMemo(() => {
    const exact = schedule.find(
      (d) => d.dayNumber === state.activeProgramDay && !d.isRestDay
    );
    if (exact) return exact;
    return (
      schedule.find(
        (d) => d.dayNumber >= state.activeProgramDay && !d.isRestDay
      ) ?? schedule[0]
    );
  }, [schedule, state.activeProgramDay]);

  const handleSetInitialBaselineMax = (maxReps: number) => {
    const clean = Math.max(1, Math.round(maxReps));
    setState((prev) => ({
      ...prev,
      baselineMax: clean,
      trainingCapacity: clean,
      activeProgramDay: 1,
    }));
  };

  const handleUpdateBaselineMax = (newMax: number) => {
    const clean = Math.max(1, Math.round(newMax));
    setState((prev) => ({
      ...prev,
      baselineMax: clean,
      trainingCapacity: clean,
    }));
  };

  const handleCompleteWorkout = useCallback(
    (payload: {
      mode: SessionMode;
      totalReps: number;
      setsCompleted?: number[];
      durationSec: number;
      programDay?: number;
    }): string | null => {
      const now = new Date();
      let feedbackMsg: string | null = null;

      setState((prev) => {
        const nextSessions = [
          ...prev.sessions,
          {
            id: `${now.getTime()}-${Math.random().toString(36).slice(2, 7)}`,
            timestamp: now.toISOString(),
            dateKey: toLocalDateKey(now),
            reps: payload.totalReps,
            setsCompleted: payload.setsCompleted,
            durationSec: payload.durationSec,
            mode: payload.mode,
            programDay: payload.programDay,
          },
        ];

        if (payload.mode === 'max_test') {
          const isFirstBaseline = prev.baselineMax === null;
          const nextBase = isFirstBaseline
            ? payload.totalReps
            : prev.baselineMax;
          const nextCap = Math.max(prev.trainingCapacity, payload.totalReps);
          feedbackMsg = isFirstBaseline
            ? `Baseline set at ${payload.totalReps} unbroken reps! Your custom 5-set progression program is ready.`
            : payload.totalReps > prev.trainingCapacity
              ? `New max ceiling (${payload.totalReps} reps)! Future program sets automatically scaled up.`
              : `Max test logged (${payload.totalReps} reps).`;

          return {
            ...prev,
            baselineMax: nextBase,
            trainingCapacity: nextCap,
            sessions: nextSessions,
          };
        }

        if (payload.mode === 'program' && payload.programDay) {
          const dayPlan =
            build30DayProgram(prev).find(
              (d) => d.dayNumber === payload.programDay
            ) ?? todayProgramWorkout;

          const { nextCapacity, advancedDay, feedback } =
            evaluateProgramProgression(
              prev.trainingCapacity,
              dayPlan.sets,
              payload.setsCompleted ?? [payload.totalReps]
            );
          feedbackMsg = feedback;

          const completedSet = new Set(prev.completedProgramDays);
          if (advancedDay) {
            completedSet.add(payload.programDay);
          }

          // Advance activeProgramDay to next non-rest day
          let nextDay = prev.activeProgramDay;
          if (advancedDay && payload.programDay >= prev.activeProgramDay) {
            nextDay = Math.min(30, payload.programDay + 1);
            if (nextDay % 4 === 0 && nextDay < 30) {
              nextDay += 1;
            }
          }

          return {
            ...prev,
            baselineMax: prev.baselineMax ?? Math.round(prev.trainingCapacity),
            trainingCapacity: nextCapacity,
            activeProgramDay: nextDay,
            completedProgramDays: Array.from(completedSet),
            sessions: nextSessions,
          };
        }

        feedbackMsg = `${payload.totalReps} reps added toward your ${prev.settings.dailyGoal}/day goal.`;
        return {
          ...prev,
          sessions: nextSessions,
        };
      });

      return feedbackMsg;
    },
    [todayProgramWorkout]
  );

  const handleUpdateSettings = (patch: Partial<UserSettings>) => {
    setState((prev) => ({
      ...prev,
      settings: {
        ...prev.settings,
        ...patch,
      },
    }));
  };

  const handleDeleteSession = (id: string) => {
    setState((prev) => ({
      ...prev,
      sessions: prev.sessions.filter((s) => s.id !== id),
    }));
  };

  const handleTriggerInstall = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  };

  const metrics = computeDashboardMetrics(state);

  return (
    <div className={`app-container ${workoutFullscreen ? 'workout-fullscreen' : ''}`}>
      {!workoutFullscreen && (
        <header className="app-header">
          <div className="brand-row">
            <div className="brand-logo-box" aria-hidden="true">
              {/* Crisp Athletic Push-Up Plank Logo */}
              <svg width="26" height="26" viewBox="0 0 64 64" fill="none">
                <line
                  x1="7"
                  y1="49"
                  x2="57"
                  y2="49"
                  stroke="var(--lime)"
                  strokeWidth="3.5"
                  strokeLinecap="round"
                />
                <circle cx="50" cy="23" r="5" fill="var(--lime)" />
                <path
                  d="M11 45L29 35L42 26.5L43.5 45"
                  stroke="var(--lime)"
                  strokeWidth="5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M11 45L9.5 39.5"
                  stroke="var(--lime)"
                  strokeWidth="3.8"
                  strokeLinecap="round"
                />
              </svg>
            </div>
            <div>
              <h1 className="brand-name">Pushups</h1>
              <span className="brand-tagline">Floor Sensor + Front Camera Trainer</span>
            </div>
          </div>

          <div className={`streak-pill ${metrics.streak > 0 ? 'lit' : ''}`}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M12 2c.5 3.5 4 6 4 10a4 4 0 1 1-8 0c0-2 .8-3.8 2-5.2-.2 1.8 1 2.7 2 2.2 0-2.5-.5-4.8 0-7z" />
            </svg>
            <span>{metrics.streak}d</span>
          </div>
        </header>
      )}

      <main style={{ flex: 1 }}>
        {activeTab === 'train' && (
          <TrainView
            state={state}
            todayProgramWorkout={todayProgramWorkout}
            launchRequest={launchRequest}
            onConsumeLaunchRequest={() => setLaunchRequest(null)}
            orientationMonitor={orientationMonitor}
            orientation={orientation}
            onWorkoutScreenChange={setWorkoutFullscreen}
            onToggleMute={() =>
              handleUpdateSettings({ soundEnabled: !state.settings.soundEnabled })
            }
            onSetInitialBaselineMax={handleSetInitialBaselineMax}
            onCompleteWorkout={handleCompleteWorkout}
          />
        )}

        {activeTab === 'program' && (
          <Program30View
            state={state}
            onStartProgramDay={(workout) => {
              setActiveTab('train');
              setLaunchRequest({ mode: 'program', programWorkout: workout });
            }}
            onStartMaxTest={() => {
              setActiveTab('train');
              setLaunchRequest({ mode: 'max_test' });
            }}
          />
        )}

        {activeTab === 'stats' && (
          <StatsView state={state} onDeleteSession={handleDeleteSession} />
        )}

        {activeTab === 'setup' && (
          <SetupView
            state={state}
            installPrompt={installPrompt}
            onTriggerInstall={handleTriggerInstall}
            onUpdateSettings={handleUpdateSettings}
            onUpdateBaselineMax={handleUpdateBaselineMax}
            onLaunchMaxTest={() => {
              setActiveTab('train');
              setLaunchRequest({ mode: 'max_test' });
            }}
          />
        )}
      </main>

      {!workoutFullscreen && (
        <nav className="bottom-dock" aria-label="Primary Navigation">
          <div className="bottom-dock-inner">
            <button
              type="button"
              id="tab-train"
              className={`dock-tab ${activeTab === 'train' ? 'active' : ''}`}
              onClick={() => setActiveTab('train')}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 10.5L12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1v-9.5z" />
              </svg>
              <span>Train</span>
            </button>

            <button
              type="button"
              id="tab-program"
              className={`dock-tab ${activeTab === 'program' ? 'active' : ''}`}
              onClick={() => setActiveTab('program')}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="8" r="5" />
                <path d="M9 12.5L7.5 21l4.5-2.5L16.5 21 15 12.5" />
              </svg>
              <span>30-Day</span>
            </button>

            <button
              type="button"
              id="tab-stats"
              className={`dock-tab ${activeTab === 'stats' ? 'active' : ''}`}
              onClick={() => setActiveTab('stats')}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M4 20h16M8 16v-5M12 16V7M16 16v-8" strokeLinecap="round" />
              </svg>
              <span>Stats</span>
            </button>

            <button
              type="button"
              id="tab-setup"
              className={`dock-tab ${activeTab === 'setup' ? 'active' : ''}`}
              onClick={() => setActiveTab('setup')}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.77 1.02 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              <span>Setup</span>
            </button>
          </div>
        </nav>
      )}
    </div>
  );
}

export default App;

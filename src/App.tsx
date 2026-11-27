import { useEffect, useMemo, useState } from 'react';
import type {
  ChallengePlanId,
  ChallengeState,
  UserSettings,
  WorkoutMode,
} from './services/challengeStore';
import {
  getTodayChallengeInfo,
  loadChallengeState,
  saveChallengeState,
  toLocalDateKey,
} from './services/challengeStore';
import type { OrientationSnapshot } from './services/orientationSensor';
import { GroundOrientationMonitor } from './services/orientationSensor';
import { FloorTrainerView } from './components/FloorTrainerView';
import { ChallengeView } from './components/ChallengeView';
import type { BeforeInstallPromptEvent } from './components/SettingsView';
import { SettingsView } from './components/SettingsView';

type ActiveTab = 'train' | 'challenge' | 'settings';

export function App() {
  const [state, setState] = useState<ChallengeState>(() => loadChallengeState());
  const [activeTab, setActiveTab] = useState<ActiveTab>('train');
  const [hudFullscreen, setHudFullscreen] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  const orientationMonitor = useMemo(() => new GroundOrientationMonitor(), []);
  const [orientation, setOrientation] = useState<OrientationSnapshot>(() =>
    orientationMonitor.getSnapshot()
  );

  // Persist challenge state
  useEffect(() => {
    saveChallengeState(state);
  }, [state]);

  // Subscribe to ground level orientation monitor
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

  // Capture installable PWA prompt
  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const handleSaveSession = (
    reps: number,
    durationSec: number,
    mode: WorkoutMode | 'manual',
    avgDepthPct: number
  ) => {
    const now = new Date();
    setState((prev) => ({
      ...prev,
      sessions: [
        ...prev.sessions,
        {
          id: `${now.getTime()}-${Math.random().toString(36).slice(2, 7)}`,
          timestamp: now.toISOString(),
          dateKey: toLocalDateKey(now),
          reps,
          durationSec,
          mode,
          avgDepthPct,
        },
      ],
    }));
  };

  const handleChangePlan = (planId: ChallengePlanId, customGoal?: number) => {
    setState((prev) => ({
      ...prev,
      planId,
      customDailyGoal: customGoal ?? prev.customDailyGoal,
    }));
  };

  const handleResetStartDate = () => {
    setState((prev) => ({
      ...prev,
      startDateKey: toLocalDateKey(),
    }));
  };

  const handleDeleteSession = (id: string) => {
    setState((prev) => ({
      ...prev,
      sessions: prev.sessions.filter((s) => s.id !== id),
    }));
  };

  const handleUpdateSettings = (patch: Partial<UserSettings>) => {
    setState((prev) => ({
      ...prev,
      settings: {
        ...prev.settings,
        ...patch,
      },
    }));
  };

  const handleExportData = () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `floorrep-backup-${toLocalDateKey()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleTriggerInstall = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  };

  const todayInfo = getTodayChallengeInfo(state);

  return (
    <div className={`app-shell ${hudFullscreen ? 'hud-fullscreen' : ''}`}>
      {!hudFullscreen && (
        <header className="top-bar">
          <div className="brand-lockup">
            <div className="brand-mark" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 128 128" fill="none">
                <path d="M28 32L64 68L100 32V54L64 90L28 54V32Z" fill="var(--accent-lime)" />
                <line
                  x1="20"
                  y1="104"
                  x2="108"
                  y2="104"
                  stroke="var(--accent-lime)"
                  strokeWidth="9"
                  strokeLinecap="round"
                />
              </svg>
            </div>
            <div>
              <h1 className="brand-title">FloorRep</h1>
              <span className="brand-subtitle">Ground Camera Counter</span>
            </div>
          </div>

          <div className={`streak-chip ${todayInfo.streak > 0 ? 'active' : ''}`} title="Current daily challenge streak">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M13.5.67s.74 2.65.74 4.8c0 2.06-1.35 3.73-3.41 3.73-2.07 0-3.63-1.67-3.63-3.73l.03-.36C5.21 7.51 4 10.62 4 14c0 4.42 3.58 8 8 8s8-3.58 8-8C20 8.61 17.41 3.8 13.5.67z" />
            </svg>
            <span>{todayInfo.streak}D STREAK</span>
          </div>
        </header>
      )}

      <main style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {activeTab === 'train' && (
          <FloorTrainerView
            state={state}
            orientationMonitor={orientationMonitor}
            orientation={orientation}
            onActiveHudChange={setHudFullscreen}
            onSaveSession={(reps, dur, mode, depth) => handleSaveSession(reps, dur, mode, depth)}
          />
        )}

        {activeTab === 'challenge' && (
          <ChallengeView
            state={state}
            onChangePlan={handleChangePlan}
            onResetStartDate={handleResetStartDate}
            onAddManualSet={(reps) => handleSaveSession(reps, 0, 'manual', 100)}
            onDeleteSession={handleDeleteSession}
          />
        )}

        {activeTab === 'settings' && (
          <SettingsView
            settings={state.settings}
            orientation={orientation}
            installPrompt={installPrompt}
            onTriggerInstall={handleTriggerInstall}
            onUpdateSettings={handleUpdateSettings}
            onExportData={handleExportData}
          />
        )}
      </main>

      {!hudFullscreen && (
        <nav className="bottom-nav" aria-label="Main Navigation">
          <div className="bottom-nav-inner">
            <button
              type="button"
              id="nav-tab-train"
              className={`nav-tab ${activeTab === 'train' ? 'active' : ''}`}
              onClick={() => setActiveTab('train')}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1">
                <circle cx="12" cy="12" r="9" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              <span>Floor Counter</span>
            </button>

            <button
              type="button"
              id="nav-tab-challenge"
              className={`nav-tab ${activeTab === 'challenge' ? 'active' : ''}`}
              onClick={() => setActiveTab('challenge')}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1">
                <rect x="3" y="4" width="18" height="17" rx="3" />
                <path d="M8 2v4M16 2v4M3 10h18" />
              </svg>
              <span>30D Challenge</span>
            </button>

            <button
              type="button"
              id="nav-tab-settings"
              className={`nav-tab ${activeTab === 'settings' ? 'active' : ''}`}
              onClick={() => setActiveTab('settings')}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1">
                <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" />
                <circle cx="9" cy="6" r="2" fill="var(--bg-base)" />
                <circle cx="15" cy="12" r="2" fill="var(--bg-base)" />
                <circle cx="10" cy="18" r="2" fill="var(--bg-base)" />
              </svg>
              <span>Calibrate</span>
            </button>
          </div>
        </nav>
      )}
    </div>
  );
}

export default App;

export type ChallengePlanId = 'progressive30' | 'beast100' | 'builder60' | 'custom';
export type WorkoutMode = 'daily' | 'amrap60' | 'free';
export type SensitivityPreset = 'strict' | 'standard' | 'relaxed';

export interface PushUpSession {
  id: string;
  timestamp: string; // ISO string
  dateKey: string; // YYYY-MM-DD local
  reps: number;
  durationSec: number;
  mode: WorkoutMode | 'manual';
  avgDepthPct: number;
}

export interface UserSettings {
  soundEnabled: boolean;
  hapticsEnabled: boolean;
  screenTorchInDark: boolean;
  sensitivity: SensitivityPreset;
  flatToleranceDeg: number; // Default 12 deg
}

export interface ChallengeState {
  planId: ChallengePlanId;
  customDailyGoal: number;
  startDateKey: string; // YYYY-MM-DD
  sessions: PushUpSession[];
  settings: UserSettings;
}

const STORAGE_KEY = 'floorrep_challenge_state_v1';

export function toLocalDateKey(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDaysToKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return toLocalDateKey(dt);
}

export function diffDaysBetweenKeys(startKey: string, endKey: string): number {
  const [y1, m1, d1] = startKey.split('-').map(Number);
  const [y2, m2, d2] = endKey.split('-').map(Number);
  const t1 = Date.UTC(y1, m1 - 1, d1);
  const t2 = Date.UTC(y2, m2 - 1, d2);
  return Math.floor((t2 - t1) / (1000 * 60 * 60 * 24));
}

export const CHALLENGE_PLANS: Record<
  ChallengePlanId,
  { name: string; tagline: string; getTargetForDay: (dayIndex1Based: number, customGoal: number) => number }
> = {
  progressive30: {
    name: '30-Day Progressive',
    tagline: '25 → 100 reps/day with active taper every 4th day',
    getTargetForDay: (day) => {
      const clamped = Math.max(1, Math.min(30, day));
      if (clamped === 30) return 100;
      const base = Math.round(25 + ((clamped - 1) / 29) * 75);
      // Every 4th day is a 70% active recovery volume day
      if (clamped % 4 === 0) {
        return Math.round((base * 0.7) / 5) * 5;
      }
      return Math.round(base / 5) * 5;
    },
  },
  beast100: {
    name: '100 / Day Centurion',
    tagline: '100 clean push-ups every day for 30 days (3,000 total)',
    getTargetForDay: () => 100,
  },
  builder60: {
    name: 'Foundation 15 → 60',
    tagline: 'Steady strength ramp from 15 to 60 daily push-ups',
    getTargetForDay: (day) => {
      const clamped = Math.max(1, Math.min(30, day));
      if (clamped === 30) return 60;
      const raw = 15 + ((clamped - 1) / 29) * 45;
      return clamped % 5 === 0 ? Math.max(15, Math.round((raw * 0.75) / 5) * 5) : Math.round(raw / 5) * 5;
    },
  },
  custom: {
    name: 'Custom Daily Target',
    tagline: 'Fixed daily push-up quota tailored to your routine',
    getTargetForDay: (_day, customGoal) => Math.max(5, customGoal),
  },
};

export function createDefaultState(): ChallengeState {
  return {
    planId: 'progressive30',
    customDailyGoal: 50,
    startDateKey: toLocalDateKey(),
    sessions: [],
    settings: {
      soundEnabled: true,
      hapticsEnabled: true,
      screenTorchInDark: true,
      sensitivity: 'standard',
      flatToleranceDeg: 12,
    },
  };
}

export function loadChallengeState(): ChallengeState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createDefaultState();
    const parsed = JSON.parse(raw) as Partial<ChallengeState>;
    const defaults = createDefaultState();
    return {
      ...defaults,
      ...parsed,
      settings: {
        ...defaults.settings,
        ...(parsed.settings ?? {}),
      },
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    };
  } catch {
    return createDefaultState();
  }
}

export function saveChallengeState(state: ChallengeState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage quota issues
  }
}

export function getDailyTotalsMap(sessions: PushUpSession[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const s of sessions) {
    totals[s.dateKey] = (totals[s.dateKey] ?? 0) + s.reps;
  }
  return totals;
}

export function getTodayChallengeInfo(state: ChallengeState, todayKey: string = toLocalDateKey()) {
  const dayOffset = diffDaysBetweenKeys(state.startDateKey, todayKey);
  const currentDayNumber = Math.max(1, Math.min(30, dayOffset + 1));
  const plan = CHALLENGE_PLANS[state.planId];
  const todayTarget = plan.getTargetForDay(currentDayNumber, state.customDailyGoal);
  const dailyTotals = getDailyTotalsMap(state.sessions);
  const todayReps = dailyTotals[todayKey] ?? 0;
  const remaining = Math.max(0, todayTarget - todayReps);
  const progressPct = Math.min(100, Math.round((todayReps / Math.max(1, todayTarget)) * 100));

  // Compute current streak (consecutive days meeting target up to today or yesterday)
  let streak = 0;
  for (let i = 0; i < 365; i++) {
    const checkKey = addDaysToKey(todayKey, -i);
    const dIdx = Math.max(1, Math.min(30, diffDaysBetweenKeys(state.startDateKey, checkKey) + 1));
    const target = plan.getTargetForDay(dIdx, state.customDailyGoal);
    const done = dailyTotals[checkKey] ?? 0;
    if (done >= target) {
      streak++;
    } else if (i === 0) {
      // Today still in progress; check yesterday onwards
      continue;
    } else {
      break;
    }
  }

  const totalLifetimeReps = state.sessions.reduce((sum, s) => sum + s.reps, 0);
  const bestSingleSet = state.sessions.reduce((max, s) => Math.max(max, s.reps), 0);

  return {
    currentDayNumber,
    todayTarget,
    todayReps,
    remaining,
    progressPct,
    streak,
    totalLifetimeReps,
    bestSingleSet,
    dailyTotals,
  };
}

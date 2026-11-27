export type SessionMode = 'program' | 'daily' | 'max_test';
export type CameraPlacementMode = 'both' | 'face' | 'chest';
export type DepthRequirement = 'easy' | 'normal' | 'strict';

export interface PrescribedWorkout {
  dayNumber: number; // 1..30
  isRestDay: boolean;
  sets: number[]; // e.g. [3, 4, 3, 3, 4]
  totalMinReps: number; // sum of sets
  restSeconds: number; // rest between sets
  label: string; // e.g. "3 · 4 · 3 · 3 · 4+"
}

export interface PushUpSession {
  id: string;
  timestamp: string;
  dateKey: string; // YYYY-MM-DD
  reps: number;
  setsCompleted?: number[];
  durationSec: number;
  mode: SessionMode | 'manual';
  programDay?: number;
}

export interface UserSettings {
  dailyGoal: number;
  placementMode: CameraPlacementMode;
  depthRequirement: DepthRequirement;
  flatToleranceDeg: 8 | 12 | 18;
  soundEnabled: boolean;
  spokenEnabled: boolean;
  screenTorchInDark: boolean;
}

export interface ChallengeState {
  baselineMax: number | null; // null until user runs initial Max Test or sets baseline
  trainingCapacity: number; // dynamic working max capacity adjusted by performance
  activeProgramDay: number; // 1..30 current position in 30-day program
  completedProgramDays: number[]; // list of completed day numbers (1..30)
  sessions: PushUpSession[];
  settings: UserSettings;
}

const STORAGE_KEY = 'pushups_pwa_state_v2';

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

/**
 * Computes a clear, motivating unbroken push-up milestone goal from the user's starting baseline max.
 */
export function getMilestoneGoal(baselineMax: number | null, bestPR: number): number {
  const ref = Math.max(baselineMax ?? 0, bestPR);
  if (ref === 0) return 25;
  if (ref < 10) return 25;
  if (ref < 20) return 40;
  if (ref < 35) return 60;
  if (ref < 55) return 80;
  if (ref < 100) return 100;
  return Math.ceil((ref + 25) / 25) * 25;
}

/**
 * Generates a 5-set wave progression workout (e.g. 3 · 4 · 3 · 3 · 4+ for capacity=5)
 * tailored to an effective unbroken push-up capacity.
 */
export function prescribeSetsFromCapacity(rawCapacity: number): {
  sets: number[];
  restSeconds: number;
} {
  const c = Math.max(2, rawCapacity);

  if (c < 3) {
    return { sets: [1, 2, 1, 1, 2], restSeconds: 45 };
  }
  if (c < 4) {
    return { sets: [2, 2, 2, 1, 2], restSeconds: 45 };
  }

  // Wave structure: Warm-in (60%), Peak early set (76%), Density 1 (58%), Density 2 (58%), Final AMRAP+ (72%)
  // At c = 5 -> [3, 4, 3, 3, 4] -> "3 · 4 · 3 · 3 · 4+" (17+ total reps)
  const s1 = Math.max(2, Math.round(c * 0.6));
  const s2 = Math.max(2, Math.round(c * 0.76));
  const s3 = Math.max(2, Math.round(c * 0.58));
  const s4 = Math.max(2, Math.round(c * 0.58));
  const s5 = Math.max(2, Math.round(c * 0.72));

  const restSeconds = c <= 10 ? 45 : c <= 25 ? 60 : 75;
  return { sets: [s1, s2, s3, s4, s5], restSeconds };
}

export function formatSetsLabel(sets: number[], plusOnLast = true): string {
  return sets
    .map((n, idx) => (plusOnLast && idx === sets.length - 1 ? `${n}+` : String(n)))
    .join(' · ');
}

/**
 * Generates the full 30-day structured program schedule anchored on the user's current trainingCapacity
 * and activeProgramDay. Every 4th day (D4, D8, D12, D16, D20, D24, D28) is an active recovery REST day.
 */
export function build30DayProgram(state: ChallengeState): PrescribedWorkout[] {
  const baseCap = state.baselineMax !== null ? state.trainingCapacity : 8;
  const anchorDay = Math.max(1, state.activeProgramDay);

  // Count training sessions up to each day to scale progressive overload smoothly
  let trainingIndex = 0;
  const trainingIndexByDay: number[] = [];
  for (let d = 1; d <= 30; d++) {
    const isRest = d % 4 === 0;
    if (!isRest) trainingIndex++;
    trainingIndexByDay[d] = trainingIndex;
  }

  const anchorTrainIdx = Math.max(1, trainingIndexByDay[anchorDay] || 1);

  const schedule: PrescribedWorkout[] = [];
  for (let d = 1; d <= 30; d++) {
    const isRestDay = d % 4 === 0;
    if (isRestDay) {
      schedule.push({
        dayNumber: d,
        isRestDay: true,
        sets: [],
        totalMinReps: 0,
        restSeconds: 0,
        label: 'REST',
      });
      continue;
    }

    const tIdx = trainingIndexByDay[d];
    const deltaSessions = tIdx - anchorTrainIdx;
    // Progressive overload curve: ~4.5% compounding + 0.35 linear floor per workout session
    const projectedCap = Math.max(
      2,
      baseCap * Math.pow(1.042, deltaSessions) + deltaSessions * 0.35
    );
    const { sets, restSeconds } = prescribeSetsFromCapacity(projectedCap);
    const totalMinReps = sets.reduce((a, b) => a + b, 0);

    schedule.push({
      dayNumber: d,
      isRestDay: false,
      sets,
      totalMinReps,
      restSeconds,
      label: formatSetsLabel(sets, true),
    });
  }

  return schedule;
}

/**
 * Closed-loop adaptive update after finishing a 5-set guided program workout.
 */
export function evaluateProgramProgression(
  currentCapacity: number,
  prescribedSets: number[],
  actualSets: number[]
): { nextCapacity: number; advancedDay: boolean; feedback: string } {
  const targetTotal = prescribedSets.reduce((a, b) => a + b, 0);
  const actualTotal = actualSets.reduce((a, b) => a + b, 0);
  const lastTarget = prescribedSets[prescribedSets.length - 1] ?? 1;
  const lastActual = actualSets[actualSets.length - 1] ?? 0;

  if (actualTotal >= targetTotal && lastActual >= lastTarget + 2) {
    const boost = Math.max(1.2, currentCapacity * 0.09);
    return {
      nextCapacity: Number((currentCapacity + boost).toFixed(2)),
      advancedDay: true,
      feedback: `Strong finish (+${lastActual - lastTarget} bonus reps on final set) — next workout scaled up!`,
    };
  }

  if (actualTotal >= Math.ceil(targetTotal * 0.9)) {
    const step = Math.max(0.65, currentCapacity * 0.05);
    return {
      nextCapacity: Number((currentCapacity + step).toFixed(2)),
      advancedDay: true,
      feedback: 'All sets locked in! Advancing to the next training day.',
    };
  }

  // Consolidated session if <90% of prescribed volume completed
  const slightTrim = actualTotal < targetTotal * 0.6 ? Math.max(2, currentCapacity * 0.95) : currentCapacity;
  return {
    nextCapacity: Number(slightTrim.toFixed(2)),
    advancedDay: false,
    feedback: 'Good volume logged — keeping this level for your next workout so you crush every set.',
  };
}

export function createDefaultState(): ChallengeState {
  return {
    baselineMax: null,
    trainingCapacity: 8,
    activeProgramDay: 1,
    completedProgramDays: [],
    sessions: [],
    settings: {
      dailyGoal: 50,
      placementMode: 'both',
      depthRequirement: 'normal',
      flatToleranceDeg: 12,
      soundEnabled: true,
      spokenEnabled: true,
      screenTorchInDark: true,
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
      completedProgramDays: Array.isArray(parsed.completedProgramDays)
        ? parsed.completedProgramDays
        : [],
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
    // Ignore storage quota errors
  }
}

export function getDailyTotalsMap(sessions: PushUpSession[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const s of sessions) {
    map[s.dateKey] = (map[s.dateKey] ?? 0) + s.reps;
  }
  return map;
}

export function computeDashboardMetrics(state: ChallengeState, todayKey: string = toLocalDateKey()) {
  const dailyTotals = getDailyTotalsMap(state.sessions);
  const todayReps = dailyTotals[todayKey] ?? 0;
  const dailyGoal = state.settings.dailyGoal;
  const remainingToday = Math.max(0, dailyGoal - todayReps);
  const todayPct = Math.min(100, Math.round((todayReps / Math.max(1, dailyGoal)) * 100));

  const totalLifetimeReps = state.sessions.reduce((acc, s) => acc + s.reps, 0);
  const bestSessionSet = state.sessions.reduce((max, s) => {
    const bestInSets = s.setsCompleted && s.setsCompleted.length > 0 ? Math.max(...s.setsCompleted) : s.reps;
    return Math.max(max, bestInSets);
  }, state.baselineMax ?? 0);

  // Active daily streak (days with >= dailyGoal OR a completed program workout)
  const programDates = new Set(
    state.sessions.filter((s) => s.mode === 'program' || s.mode === 'max_test').map((s) => s.dateKey)
  );
  let streak = 0;
  for (let i = 0; i < 365; i++) {
    const key = addDaysToKey(todayKey, -i);
    const hitDaily = (dailyTotals[key] ?? 0) >= dailyGoal || programDates.has(key);
    if (hitDaily) {
      streak++;
    } else if (i === 0) {
      continue;
    } else {
      break;
    }
  }

  const milestoneGoal = getMilestoneGoal(state.baselineMax, bestSessionSet);
  const estimatedMax =
    state.baselineMax !== null ? Math.max(bestSessionSet, Math.round(state.trainingCapacity)) : 0;

  return {
    todayReps,
    dailyGoal,
    remainingToday,
    todayPct,
    totalLifetimeReps,
    bestSetPR: bestSessionSet,
    estimatedMax,
    milestoneGoal,
    streak,
    dailyTotals,
  };
}

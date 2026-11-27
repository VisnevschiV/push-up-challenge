import React from 'react';
import type { ChallengeState } from '../services/challengeStore';
import { addDaysToKey, computeDashboardMetrics, toLocalDateKey } from '../services/challengeStore';

interface StatsViewProps {
  state: ChallengeState;
  onDeleteSession: (id: string) => void;
}

const WEEKDAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

export const StatsView: React.FC<StatsViewProps> = ({ state, onDeleteSession }) => {
  const todayKey = toLocalDateKey();
  const metrics = computeDashboardMetrics(state, todayKey);

  // Build last 14 days data (oldest -> today)
  const last14 = Array.from({ length: 14 }, (_, idx) => {
    const offset = idx - 13;
    const key = addDaysToKey(todayKey, offset);
    const [y, m, d] = key.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    const reps = metrics.dailyTotals[key] ?? 0;
    return {
      key,
      dayChar: WEEKDAY_LETTERS[dt.getDay()],
      reps,
    };
  });

  const maxBarScale = Math.max(
    metrics.dailyGoal,
    ...last14.map((d) => d.reps),
    10
  );

  const goalPct = Math.min(
    100,
    Math.round((metrics.bestSetPR / Math.max(1, metrics.milestoneGoal)) * 100)
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Card 1: All-Time Performance & Clear Goal */}
      <section className="card">
        <span className="card-label" style={{ display: 'block', marginBottom: 14 }}>
          ALL-TIME PERFORMANCE
        </span>

        <div className="mini-stats-grid">
          <div className="mini-stat-box">
            <div className="mini-stat-val">{metrics.totalLifetimeReps}</div>
            <div className="mini-stat-lbl">Total Reps</div>
          </div>
          <div className="mini-stat-box">
            <div className="mini-stat-val">{metrics.bestSetPR}</div>
            <div className="mini-stat-lbl">Best Set (PR)</div>
          </div>
          <div className="mini-stat-box">
            <div className="mini-stat-val">{metrics.streak}d</div>
            <div className="mini-stat-lbl">Active Streak</div>
          </div>
        </div>

        {/* Clear Goal Progression */}
        <div
          style={{
            marginTop: 14,
            background: 'var(--bg-card-inner)',
            borderRadius: 14,
            padding: '13px 15px',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              fontSize: '0.8rem',
              marginBottom: 8,
            }}
          >
            <span style={{ color: 'var(--text-secondary)' }}>
              Unbroken Goal:{' '}
              <strong style={{ color: 'var(--text-primary)' }}>
                {metrics.bestSetPR} / {metrics.milestoneGoal} reps
              </strong>
            </span>
            <span className="mono-num" style={{ color: 'var(--lime)', fontWeight: 700 }}>
              {goalPct}%
            </span>
          </div>
          <div
            style={{
              height: 7,
              borderRadius: 99,
              background: '#0d1013',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${goalPct}%`,
                height: '100%',
                background: 'var(--lime)',
                borderRadius: 99,
                transition: 'width 0.3s ease',
              }}
            />
          </div>
          {state.baselineMax !== null && (
            <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: 6 }}>
              Started at {state.baselineMax} max · Working capacity now{' '}
              {Math.round(state.trainingCapacity)} reps
            </div>
          )}
        </div>
      </section>

      {/* Card 2: Last 14 Days Bar Chart */}
      <section className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="card-label">LAST 14 DAYS</span>
          <span className="mono-num" style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
            Goal: {metrics.dailyGoal}/day
          </span>
        </div>

        <div className="bars-14-grid" aria-label="Last 14 days push-up volume">
          {last14.map((item) => {
            const heightPct =
              item.reps === 0
                ? 4
                : Math.max(10, Math.round((item.reps / maxBarScale) * 100));
            const hitGoal = item.reps >= metrics.dailyGoal;

            return (
              <div key={item.key} className="bar-col" title={`${item.key}: ${item.reps} reps`}>
                <div className="bar-pillar-wrap">
                  <div
                    className={`bar-pillar ${
                      hitGoal ? 'goal-hit' : item.reps > 0 ? 'has-reps' : ''
                    }`}
                    style={{ height: `${heightPct}%` }}
                  />
                </div>
                <span className="bar-day-char">{item.dayChar}</span>
              </div>
            );
          })}
        </div>
      </section>

      {/* Card 3: Session Log */}
      <section className="card">
        <span className="card-label" style={{ display: 'block', marginBottom: 12 }}>
          SESSION LOG
        </span>

        {state.sessions.length === 0 ? (
          <p style={{ margin: 0, fontSize: '0.88rem', color: 'var(--text-secondary)' }}>
            No completed sets yet. Place your phone face-up on the floor and knock out your first
            set!
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            {state.sessions
              .slice()
              .reverse()
              .slice(0, 12)
              .map((s) => {
                const modeBadge =
                  s.mode === 'max_test'
                    ? 'Max Test'
                    : s.mode === 'program'
                      ? `Program D${s.programDay ?? ''}`
                      : 'Daily Set';
                const setsStr =
                  s.setsCompleted && s.setsCompleted.length > 1
                    ? ` (${s.setsCompleted.join('·')})`
                    : '';

                return (
                  <div
                    key={s.id}
                    style={{
                      background: 'var(--bg-card-inner)',
                      borderRadius: 13,
                      padding: '11px 14px',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <div>
                      <span
                        className="mono-num"
                        style={{ fontWeight: 700, color: 'var(--lime)', fontSize: '0.96rem' }}
                      >
                        {s.reps} reps
                      </span>
                      <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginLeft: 8 }}>
                        {modeBadge}
                        {setsStr} · {s.dateKey}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => onDeleteSession(s.id)}
                      aria-label="Delete session"
                      style={{ color: 'var(--text-muted)', fontSize: '0.82rem', padding: '4px 8px' }}
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
          </div>
        )}
      </section>
    </div>
  );
};

import { useEffect, useRef, useState } from 'react';
import { advanceScenario } from '@/services/api';

/**
 * TimeSlider — simulated time scrubber for the coordinator dashboard.
 *
 * The backend advances in discrete 5-minute ticks via POST /scenario/advance.
 * Dragging the slider to a future position fires that many advance calls in
 * sequence. A "Play" button auto-advances every PLAY_INTERVAL_MS of real time.
 *
 * Props:
 *   elapsed     — current elapsed_minutes from WS payload
 *   maxMinutes  — slider upper bound (default 120 = 24 ticks)
 *   disabled    — true when no scenario is active
 *   onError     — callback(msg) for error toasts in parent
 */

const TICK_MIN = 5;           // minutes per backend tick
const MAX_MINUTES = 120;
const PLAY_INTERVAL_MS = 3000; // real ms between auto-advance calls in Play mode

function formatMin(m) {
  const h = Math.floor(m / 60);
  const min = m % 60;
  if (h === 0) return `${min}m`;
  return `${h}h ${min > 0 ? `${min}m` : ''}`;
}

export default function TimeSlider({ elapsed = 0, disabled = false, onError }) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isAdvancing, setIsAdvancing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [previewMin, setPreviewMin] = useState(null);
  const playTimerRef = useRef(null);

  const pct = Math.min(100, (elapsed / MAX_MINUTES) * 100);

  // ── Auto-play timer ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!isPlaying || disabled) {
      clearInterval(playTimerRef.current);
      return;
    }
    playTimerRef.current = setInterval(async () => {
      if (elapsed >= MAX_MINUTES) {
        setIsPlaying(false);
        return;
      }
      try {
        await advanceScenario();
      } catch (e) {
        onError?.(e.message);
        setIsPlaying(false);
      }
    }, PLAY_INTERVAL_MS);

    return () => clearInterval(playTimerRef.current);
  }, [isPlaying, disabled, elapsed, onError]);

  // Stop playing if scenario ends
  useEffect(() => {
    if (disabled) setIsPlaying(false);
  }, [disabled]);

  // ── Manual drag ──────────────────────────────────────────────────────────
  async function handleSliderChange(e) {
    const target = parseInt(e.target.value, 10);
    setPreviewMin(target);
  }

  async function handleSliderCommit(e) {
    const target = parseInt(e.target.value, 10);
    setPreviewMin(null);

    const stepsNeeded = Math.round((target - elapsed) / TICK_MIN);
    if (stepsNeeded <= 0) return;

    setIsAdvancing(true);
    try {
      for (let i = 0; i < stepsNeeded; i++) {
        await advanceScenario();
      }
    } catch (err) {
      onError?.(err.message);
    } finally {
      setIsAdvancing(false);
    }
  }

  const displayMin = previewMin ?? elapsed;
  const displayPct = Math.min(100, (displayMin / MAX_MINUTES) * 100);

  return (
    <div className="rounded-xl bg-gray-800/60 border border-gray-700/60 p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-gray-400 text-[10px] uppercase tracking-widest font-medium">
          Time Control
        </h2>
        <div className="flex items-center gap-2">
          {isAdvancing && (
            <span className="text-xs text-amber-400 animate-pulse">advancing…</span>
          )}
          {/* Play / Pause button */}
          <button
            onClick={() => setIsPlaying((p) => !p)}
            disabled={disabled || isAdvancing}
            title={isPlaying ? 'Pause auto-advance' : 'Auto-advance every 3 s'}
            className={`w-7 h-7 rounded-full flex items-center justify-center transition-colors text-xs
              ${isPlaying
                ? 'bg-amber-500/20 border border-amber-500/50 text-amber-400 hover:bg-amber-500/30'
                : 'bg-emerald-500/20 border border-emerald-500/50 text-emerald-400 hover:bg-emerald-500/30'
              }
              disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            {isPlaying ? '⏸' : '▶'}
          </button>
        </div>
      </div>

      {/* Current time display */}
      <div className="flex items-baseline gap-1 mb-3">
        <span className="text-white font-bold text-2xl leading-none">
          T+{formatMin(displayMin)}
        </span>
        {previewMin !== null && previewMin !== elapsed && (
          <span className="text-xs text-amber-400 ml-1">
            ({previewMin > elapsed ? '+' : ''}{Math.round((previewMin - elapsed) / TICK_MIN)} ticks)
          </span>
        )}
      </div>

      {/* Slider track */}
      <div className="relative mb-2">
        {/* Filled track overlay */}
        <div
          className="absolute top-1/2 -translate-y-1/2 left-0 h-1.5 rounded-full pointer-events-none"
          style={{
            width: `${displayPct}%`,
            background: isPlaying
              ? 'linear-gradient(to right, #1ABC9C, #27AE60)'
              : 'linear-gradient(to right, #1ABC9C99, #1ABC9C)',
          }}
        />
        <input
          type="range"
          min={0}
          max={MAX_MINUTES}
          step={TICK_MIN}
          value={previewMin ?? elapsed}
          disabled={disabled || isAdvancing}
          onChange={handleSliderChange}
          onMouseUp={handleSliderCommit}
          onTouchEnd={handleSliderCommit}
          className="relative w-full h-1.5 appearance-none bg-gray-700 rounded-full cursor-pointer
            disabled:opacity-40 disabled:cursor-not-allowed
            [&::-webkit-slider-thumb]:appearance-none
            [&::-webkit-slider-thumb]:w-4
            [&::-webkit-slider-thumb]:h-4
            [&::-webkit-slider-thumb]:rounded-full
            [&::-webkit-slider-thumb]:bg-white
            [&::-webkit-slider-thumb]:border-2
            [&::-webkit-slider-thumb]:border-route
            [&::-webkit-slider-thumb]:shadow-md
            [&::-webkit-slider-thumb]:cursor-grab"
        />
      </div>

      {/* Tick labels */}
      <div className="flex justify-between text-gray-600 text-[9px] px-0.5">
        {[0, 30, 60, 90, 120].map((m) => (
          <span key={m}>{m === 0 ? 'now' : formatMin(m)}</span>
        ))}
      </div>

      {/* Scenario end warning */}
      {elapsed >= MAX_MINUTES && (
        <p className="mt-2 text-xs text-amber-400 text-center">Max simulation time reached</p>
      )}
    </div>
  );
}

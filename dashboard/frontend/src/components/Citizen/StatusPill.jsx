/**
 * Status pill shown on the citizen page.
 * Transitions between Safe Route Active (green) and Route Updated (red/amber).
 *
 * Props:
 *   status        — 'safe' | 'updated' | 'reached' | 'waiting'
 */
export default function StatusPill({ status }) {
  const configs = {
    safe: {
      bg: 'bg-green-900/60 border-green-600',
      dot: 'bg-safe',
      text: 'text-safe',
      label: 'Safe Route Active',
    },
    updated: {
      bg: 'bg-orange-900/60 border-orange-500',
      dot: 'bg-orange-400 animate-ping',
      text: 'text-orange-300',
      label: 'Route Updated',
    },
    reached: {
      bg: 'bg-green-900/60 border-green-400',
      dot: 'bg-safe',
      text: 'text-safe',
      label: 'Safe Zone Reached',
    },
    waiting: {
      bg: 'bg-gray-800 border-gray-600',
      dot: 'bg-gray-500',
      text: 'text-gray-400',
      label: 'Waiting for Emergency Signal',
    },
  };

  const cfg = configs[status] || configs.waiting;

  return (
    <div
      className={`inline-flex items-center gap-2 px-4 py-2 rounded-full border ${cfg.bg} transition-all duration-500`}
    >
      <span className={`w-2.5 h-2.5 rounded-full ${cfg.dot}`} />
      <span className={`text-sm font-semibold ${cfg.text}`}>{cfg.label}</span>
    </div>
  );
}

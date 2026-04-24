/**
 * Notification feed — scrollable list of rerouting events.
 * Each card shows which citizen was rerouted and from/to which safe zone.
 *
 * Props:
 *   notifications — array of NotificationCard (newest first)
 */
export default function NotificationFeed({ notifications }) {
  const items = notifications || [];

  return (
    <div className="rounded-xl bg-gray-800/60 border border-gray-700/60 p-4 flex-1 min-h-0">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-gray-400 text-xs uppercase tracking-widest font-medium">
          Rerouting Events
        </h2>
        {items.length > 0 && (
          <span className="text-xs text-gray-500">{items.length}</span>
        )}
      </div>

      {items.length === 0 ? (
        <div className="text-gray-600 text-xs text-center py-4">
          No rerouting events yet
        </div>
      ) : (
        <div className="space-y-2 overflow-y-auto max-h-64">
          {items.map((n) => (
            <NotificationCard key={n.id} notification={n} />
          ))}
        </div>
      )}
    </div>
  );
}

function NotificationCard({ notification: n }) {
  const age = Math.round((Date.now() / 1000) - n.timestamp);
  const ageLabel = age < 60 ? `${age}s ago` : `${Math.round(age / 60)}m ago`;

  return (
    <div className="bg-gray-900/60 rounded-lg p-2.5 border border-gray-700/50">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-orange-500 shrink-0" />
          <span className="text-gray-300 text-xs font-medium">
            Citizen {n.citizen_id}
          </span>
        </div>
        <span className="text-gray-600 text-xs">{ageLabel}</span>
      </div>
      <div className="flex items-center gap-1.5 text-xs">
        <span className="text-red-400 truncate max-w-[100px]">{n.old_destination}</span>
        <span className="text-gray-500 shrink-0">→</span>
        <span className="text-safe truncate max-w-[100px]">{n.new_destination}</span>
      </div>
    </div>
  );
}

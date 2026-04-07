import { useState, useEffect } from "react";
import { fetchEvents, type AgentEvent } from "../api.ts";

export function SessionDetail({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string;
}) {
  const [events, setEvents] = useState<AgentEvent[]>([]);

  useEffect(() => {
    fetchEvents(projectId, sessionId).then(setEvents);
  }, [projectId, sessionId]);

  const eventColor: Record<string, string> = {
    session_start: "text-blue-400",
    user_message: "text-green-400",
    assistant_response: "text-cyan-400",
    tool_call: "text-yellow-400",
    tool_result: "text-orange-400",
    policy_decision: "text-purple-400",
    error: "text-red-400",
    session_end: "text-gray-400",
  };

  return (
    <div>
      <h2 className="text-2xl font-semibold mb-2">Session Events</h2>
      <p className="text-sm text-gray-500 mb-6 font-mono">{sessionId}</p>

      {events.length === 0 ? (
        <p className="text-gray-500">No events found.</p>
      ) : (
        <div className="space-y-2">
          {events.map((e) => (
            <div
              key={e.id}
              className="bg-gray-900 border border-gray-800 rounded-lg p-3"
            >
              <div className="flex items-center gap-3 mb-1">
                <span className="text-xs text-gray-600">
                  {new Date(e.timestamp).toLocaleTimeString()}
                </span>
                <span
                  className={`text-sm font-medium ${eventColor[e.type] ?? "text-gray-300"}`}
                >
                  {e.type}
                </span>
              </div>
              <pre className="text-xs text-gray-400 overflow-x-auto whitespace-pre-wrap max-h-48 overflow-y-auto">
                {JSON.stringify(e.data, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

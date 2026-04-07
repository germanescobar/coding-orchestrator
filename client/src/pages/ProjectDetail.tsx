import { useState, useEffect, useRef } from "react";
import {
  fetchSessions,
  startSession,
  type Session,
} from "../api.ts";

export function ProjectDetail({
  projectId,
  onSelectSession,
}: {
  projectId: string;
  onSelectSession: (sessionId: string) => void;
}) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [message, setMessage] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [output, setOutput] = useState<string[]>([]);
  const outputRef = useRef<HTMLDivElement>(null);

  const load = () => {
    fetchSessions(projectId).then(setSessions);
  };

  useEffect(load, [projectId]);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim() || streaming) return;

    setStreaming(true);
    setOutput([]);

    const es = startSession(projectId, message);

    es.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === "stdout" || data.type === "stderr") {
        setOutput((prev) => [...prev, data.text]);
      } else if (data.type === "done") {
        es.close();
        setStreaming(false);
        setMessage("");
        load();
      } else if (data.type === "error") {
        setOutput((prev) => [...prev, `Error: ${data.text}`]);
        es.close();
        setStreaming(false);
      }
    };

    es.onerror = () => {
      es.close();
      setStreaming(false);
    };
  };

  return (
    <div>
      <h2 className="text-2xl font-semibold mb-6">Sessions</h2>

      <form onSubmit={handleSend} className="mb-6">
        <div className="flex gap-2">
          <input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Send a message to start a new session..."
            disabled={streaming}
            className="flex-1 bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={streaming || !message.trim()}
            className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 px-4 py-2 rounded text-sm font-medium"
          >
            {streaming ? "Running..." : "Send"}
          </button>
        </div>
      </form>

      {output.length > 0 && (
        <div
          ref={outputRef}
          className="mb-6 bg-gray-900 border border-gray-800 rounded-lg p-4 max-h-96 overflow-y-auto font-mono text-sm whitespace-pre-wrap"
        >
          {output.map((line, i) => (
            <span key={i}>{line}</span>
          ))}
        </div>
      )}

      {sessions.length === 0 ? (
        <p className="text-gray-500">No sessions yet.</p>
      ) : (
        <div className="space-y-2">
          {sessions.map((s) => (
            <div
              key={s.id}
              onClick={() => onSelectSession(s.id)}
              className="bg-gray-900 border border-gray-800 rounded-lg p-4 hover:border-gray-700 cursor-pointer"
            >
              <div className="flex items-center justify-between">
                <div className="font-mono text-sm text-gray-300">
                  {s.id.slice(0, 8)}...
                </div>
                <div className="flex items-center gap-3 text-sm text-gray-500">
                  <span>{s.model}</span>
                  <span>{s.messages.length} msgs</span>
                  <span
                    className={`px-2 py-0.5 rounded text-xs ${
                      s.status === "active"
                        ? "bg-green-900 text-green-300"
                        : "bg-gray-800 text-gray-400"
                    }`}
                  >
                    {s.status}
                  </span>
                </div>
              </div>
              <div className="text-xs text-gray-600 mt-1">
                {new Date(s.lastActiveAt).toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

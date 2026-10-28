import { z } from 'zod';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { isVSCodeRuntime } from '@/lib/desktop';
import { syncDesktopSettings } from '@/lib/persistence';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useSessionUIStore } from './session-ui-store';

const moveSchema = z.object({
  sessionId: z.string().min(1),
  directory: z.string().min(1),
  status: z.enum(['registered', 'failed']),
});
const snapshotSchema = z.object({ moves: z.array(moveSchema) });
type Move = z.infer<typeof moveSchema>;
type Dependencies = {
  runtimeKey: () => string;
  subscribe: typeof subscribeOpenchamberEvents;
  onRuntimeChange: (listener: () => void) => () => void;
  load: () => Promise<z.infer<typeof snapshotSchema>>;
  retry: (move: Move) => Promise<void>;
};
const dependencies: Dependencies = {
  runtimeKey: getRuntimeKey,
  subscribe: subscribeOpenchamberEvents,
  onRuntimeChange: subscribeRuntimeEndpointChanged,
  load: async () => {
    const read = async () => {
      const response = await runtimeFetch('/api/projects/session-moves');
      if (!response.ok) throw new Error('Session move project snapshot is unavailable');
      return snapshotSchema.parse(await response.json());
    };
    const [, snapshot] = await Promise.all([syncDesktopSettings({ bootstrap: false, fresh: true }), read()]);
    return snapshot;
  },
  retry: async (move) => {
    const response = await runtimeFetch('/api/projects/session-moves/retry', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: move.sessionId, directory: move.directory }),
    });
    if (!response.ok) throw new Error('Session move project retry is unavailable');
  },
};

/** Control-stream invalidation also repairs moves observed while this UI was closed. */
export const subscribeSessionMoveProjects = (
  runtimeKey: string,
  notifyFailure: (move: Move, retry: () => void) => () => void,
  io: Dependencies = dependencies,
): (() => void) => {
  if (isVSCodeRuntime()) return () => {};
  let disposed = false;
  let requested = false;
  let refreshing = false;
  let runtimeVersion = 0;
  const notices = new Map<string, () => void>();
  const current = () => !disposed && runtimeKey === io.runtimeKey();
  const keyOf = (move: Move) => `${move.sessionId}:${move.directory}`;

  const refresh = async () => {
    requested = true;
    if (refreshing) return;
    refreshing = true;
    const version = runtimeVersion;
    const active = () => current() && version === runtimeVersion;
    try {
      while (requested && active()) {
        requested = false;
        const snapshot = await io.load();
        if (!active()) return;
        const ui = useSessionUIStore.getState();
        if (ui.currentSessionId && ui.currentSessionDirectory && !ui.newSessionDraft.open) {
          ui.reconcileSessionMoveProject(ui.currentSessionId, ui.currentSessionDirectory);
        }
        const failed = new Set(snapshot.moves.filter(move => move.status === 'failed').map(keyOf));
        for (const [key, dismiss] of notices) {
          if (!failed.has(key)) { dismiss(); notices.delete(key); }
        }
        for (const move of snapshot.moves) {
          if (move.status === 'failed') {
            const key = keyOf(move);
            if (notices.has(key)) continue;
            notices.set(key, notifyFailure(move, () => {
              if (!active()) return;
              notices.get(key)?.();
              notices.delete(key);
              void io.retry(move).catch(() => {}).finally(() => { if (active()) void refresh(); });
            }));
          }
        }
      }
    } catch (error) {
      if (current()) console.warn('Failed to synchronize moved session projects:', error);
    } finally {
      refreshing = false;
      if (requested && current()) void refresh();
    }
  };
  const unsubscribeRuntime = io.onRuntimeChange(() => {
    runtimeVersion += 1;
    for (const dismiss of notices.values()) dismiss();
    notices.clear();
  });
  const unsubscribe = io.subscribe((event) => {
    if (!current()) return;
    if (event.type === 'session-move-projects-changed' || event.type === 'event-stream-ready') void refresh();
  });
  // The shared control stream can already be connected when the session
  // pipeline rebuilds for another SDK client. Seed this subscription too.
  void refresh();
  return () => {
    disposed = true;
    unsubscribe();
    unsubscribeRuntime();
    for (const dismiss of notices.values()) dismiss();
    notices.clear();
  };
};

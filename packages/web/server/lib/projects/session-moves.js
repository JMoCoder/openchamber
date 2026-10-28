import path from 'node:path';
import { z } from 'zod';
import { createProjectIdFromPath } from './project-id.js';
import { isSpaceDirectory } from '../spaces/dispatcher.js';

const movedEventSchema = z.object({
  type: z.literal('session.moved'),
  id: z.string().min(1),
  created: z.number().finite(),
  data: z.object({
    sessionID: z.string().min(1),
    location: z.object({ directory: z.string().min(1) }),
  }),
});
const sessionEventSchema = z.discriminatedUnion('type', [movedEventSchema, movedEventSchema.extend({
  type: z.literal('session.deleted'), data: z.object({ sessionID: z.string().min(1) }),
})]);
const retrySchema = z.object({ sessionId: z.string().min(1), directory: z.string().min(1) });
const contains = (root, directory) => {
  const relative = path.relative(root, directory);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

/** Observed host moves keep their destination reachable even without a UI. */
export const createSessionMoveProjects = ({
  fsPromises,
  validateDirectoryPath,
  persistProjectRegistration,
  listWorktrees,
  excludedRoots,
  isSessionArchived,
  resolveSessionDirectory,
  broadcastUiEvent,
}) => {
  const moves = new Map();
  const snapshot = () => ({ moves: [...moves.values()].filter((move) => move.status === 'registered' || move.status === 'failed').map(({ sessionId, directory, status }) => ({ sessionId, directory, status })) });
  const announce = () => broadcastUiEvent({ type: 'openchamber:session-move-projects', properties: snapshot() });
  const excludedLexically = (directory) => isSpaceDirectory(directory)
    || excludedRoots.some((root) => contains(path.resolve(root), directory));
  const excluded = async (directory) => {
    if (excludedLexically(directory)) return true;
    const realDirectory = await fsPromises.realpath(directory);
    if (isSpaceDirectory(realDirectory)) return true;
    const realRoots = await Promise.all(excludedRoots.map((root) => fsPromises.realpath(root).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    })));
    return realRoots.some((root) => root && contains(root, realDirectory));
  };
  const register = async (move) => {
    const isCurrent = () => moves.get(move.sessionId) === move;
    const forget = () => {
      if (!isCurrent()) return;
      move.status = 'ignored';
      announce();
    };
    try {
      if (excludedLexically(path.resolve(move.directory))) {
        forget();
        return;
      }
      if (await isSessionArchived(move.sessionId)) {
        forget();
        return;
      }
      const validated = await validateDirectoryPath(move.directory);
      if (!validated.ok) throw new Error(validated.error);
      const directory = validated.directory;
      if (await excluded(directory)) {
        forget();
        return;
      }
      // One topology read of the destination, never a probe of every project.
      const worktrees = await listWorktrees(directory);
      await persistProjectRegistration((projects) => {
        if (!isCurrent()) return null;
        const owned = projects.some((project) => contains(project.path, directory)
          || worktrees.some((worktree) => contains(worktree.path, project.path)));
        if (owned) return null;
        const now = Date.now();
        return { id: createProjectIdFromPath(directory), path: directory, addedAt: now, lastOpenedAt: now };
      });
      if (!isCurrent()) return;
      move.status = 'registered';
      announce();
    } catch (error) {
      if (!isCurrent()) return;
      move.status = 'failed';
      console.warn('[projects] Session move destination could not be registered:', error?.code ?? 'registration_failed');
      announce();
    }
  };
  const accept = async (event) => {
    if (event.spaceId) return;
    if (event.payload?.type !== 'session.moved' && event.payload?.type !== 'session.deleted') return;
    const parsed = sessionEventSchema.safeParse(event.payload);
    if (!parsed.success) return;
    const { id, created, data } = parsed.data;
    const previous = moves.get(data.sessionID);
    if (previous && (previous.created > created || (previous.created === created && previous.seen.has(id)))) return;
    const seen = previous?.created === created ? previous.seen : new Set();
    seen.add(id);
    if (parsed.data.type === 'session.deleted') {
      if (previous) {
        moves.set(data.sessionID, { ...previous, created, seen, status: 'ignored' });
        announce();
      }
      return;
    }
    const move = { created, seen, sessionId: data.sessionID, directory: parsed.data.data.location.directory, status: 'pending' };
    moves.set(move.sessionId, move);
    await register(move);
  };
  const retry = async (sessionId, directory) => {
    const move = moves.get(sessionId);
    if (!move || move.status !== 'failed' || move.directory !== directory) return;
    // A retry must not restore an old destination after an unobserved move.
    const currentDirectory = await resolveSessionDirectory(sessionId);
    if (currentDirectory !== directory || await isSessionArchived(sessionId)) {
      if (moves.get(sessionId) === move) { move.status = 'ignored'; announce(); }
      return;
    }
    move.status = 'pending';
    await register(move);
  };
  return { accept, retry, snapshot };
};

export const registerSessionMoveProjectRoutes = (app, runtime) => {
  app.get('/api/projects/session-moves', (_req, res) => res.json(runtime.snapshot()));
  app.post('/api/projects/session-moves/retry', async (req, res) => {
    const parsed = retrySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Session and destination are required' });
    try {
      await runtime.retry(parsed.data.sessionId, parsed.data.directory);
      return res.json(runtime.snapshot());
    } catch {
      return res.status(503).json({ error: 'Session destination could not be checked' });
    }
  });
};

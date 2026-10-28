import { describe, expect, it, vi } from 'vitest';
import { createSessionMoveProjects } from './session-moves.js';

const event = (directory = '/destination', sessionID = 'session', created = 1) => ({
  payload: { type: 'session.moved', id: `event-${sessionID}-${created}`, created, data: { sessionID, location: { directory } } },
});
const fixture = (overrides = {}) => {
  const projects = [{ id: 'source', path: '/source', label: 'Keep me', color: 'blue' }];
  let queue = Promise.resolve();
  const writes = vi.fn();
  const deps = {
    fsPromises: { realpath: async (value) => value },
    validateDirectoryPath: vi.fn(async (directory) => ({ ok: true, directory: directory.replace(/\/+$/, '') })),
    persistProjectRegistration: vi.fn((resolve) => {
      const pending = queue.then(async () => {
        const project = await resolve(projects);
        if (!project) return false;
        writes(project); projects.push(project); return true;
      });
      queue = pending.catch(() => {});
      return pending;
    }),
    listWorktrees: vi.fn(async () => []),
    excludedRoots: ['/chats', '/data/spaces'],
    isSessionArchived: vi.fn(async () => false),
    resolveSessionDirectory: vi.fn(async () => '/destination'),
    broadcastUiEvent: vi.fn(),
    ...overrides,
  };
  return { runtime: createSessionMoveProjects(deps), deps, projects, writes };
};

describe('session move project registration', () => {
  it('ignores creation, generic updates and events from spaces without directory IO', async () => {
    const f = fixture();
    for (const type of ['session.created', 'session.updated', 'session.renamed', 'session.usage.updated']) {
      await f.runtime.accept({ ...event(), payload: { ...event().payload, type } });
    }
    await f.runtime.accept({ ...event(), spaceId: '0123456789ab' });
    expect(f.deps.validateDirectoryPath).not.toHaveBeenCalled();
    expect(f.deps.persistProjectRegistration).not.toHaveBeenCalled();
  });

  it('registers without a client, deduplicates events and concurrent sessions, and keeps metadata', async () => {
    const f = fixture();
    await Promise.all([f.runtime.accept(event()), f.runtime.accept(event()), f.runtime.accept(event('/destination', 'another'))]);
    expect(f.writes).toHaveBeenCalledTimes(1);
    expect(f.projects).toHaveLength(2);
    expect(f.projects[0]).toEqual({ id: 'source', path: '/source', label: 'Keep me', color: 'blue' });
    expect(f.deps.validateDirectoryPath).toHaveBeenCalledTimes(2);
    expect(f.runtime.snapshot().moves.every(m => m.status === 'registered')).toBe(true);
  });

  it('reuses registered roots, subdirectories and worktree ownership', async () => {
    const f = fixture({ listWorktrees: vi.fn(async () => [{ path: '/source' }, { path: '/linked' }]) });
    await f.runtime.accept(event('/source/', 'exact'));
    await f.runtime.accept(event('/source/subdirectory', 'child'));
    await f.runtime.accept(event('/linked/subdirectory', 'worktree'));
    expect(f.writes).not.toHaveBeenCalled();
  });

  it('excludes chats, space data, virtual paths and symlinks into managed roots', async () => {
    const f = fixture({ fsPromises: { realpath: async d => d === '/chat-link' ? '/chats/session' : d === '/space-link' ? '/spaces/not-real/repo' : d } });
    for (const directory of ['/chats/session', '/data/spaces/archive/one', '/spaces', '/spaces/not-real/repo', '//spaces/0123456789ab/repo', '/chat-link', '/space-link']) {
      await f.runtime.accept(event(directory, directory));
    }
    expect(f.writes).not.toHaveBeenCalled();
    expect(f.runtime.snapshot()).toEqual({ moves: [] });
  });

  it('never reports success before the settings write and exposes failed writes for reconnect and retry', async () => {
    let finish;
    const f = fixture({ persistProjectRegistration: vi.fn(() => new Promise((_, reject) => { finish = reject; })) });
    const pending = f.runtime.accept(event());
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(f.runtime.snapshot()).toEqual({ moves: [] });
    expect(f.deps.broadcastUiEvent).not.toHaveBeenCalled();
    finish(new Error('disk full'));
    await pending;
    expect(f.runtime.snapshot().moves).toEqual([{ sessionId: 'session', directory: '/destination', status: 'failed' }]);
    f.deps.persistProjectRegistration.mockResolvedValue(true);
    await f.runtime.retry('session', '/destination');
    expect(f.runtime.snapshot().moves[0].status).toBe('registered');
  });

  it('does not retry an old target after a later unobserved move', async () => {
    const f = fixture({ persistProjectRegistration: vi.fn(async () => { throw new Error('disk full'); }), resolveSessionDirectory: async () => '/newer' });
    await f.runtime.accept(event());
    await f.runtime.retry('session', '/destination');
    expect(f.deps.persistProjectRegistration).toHaveBeenCalledTimes(1);
    expect(f.runtime.snapshot()).toEqual({ moves: [] });
  });

  it('keeps a failed move retryable when the authoritative session read fails', async () => {
    const f = fixture({
      persistProjectRegistration: vi.fn(async () => { throw new Error('disk full'); }),
      resolveSessionDirectory: async () => { throw new Error('upstream unavailable'); },
    });
    await f.runtime.accept(event());
    await expect(f.runtime.retry('session', '/destination')).rejects.toThrow('upstream unavailable');
    expect(f.runtime.snapshot().moves).toEqual([{ sessionId: 'session', directory: '/destination', status: 'failed' }]);
  });

  it('refuses invalid destination directories without writing or undoing the move', async () => {
    const f = fixture({ validateDirectoryPath: async () => ({ ok: false, error: 'Directory not found' }) });
    await f.runtime.accept(event());
    expect(f.writes).not.toHaveBeenCalled();
    expect(f.runtime.snapshot().moves[0]).toMatchObject({ directory: '/destination', status: 'failed' });
  });

  it('keeps the failed destination when the retry cannot read authoritative session state', async () => {
    const f = fixture({ persistProjectRegistration: async () => { throw new Error('disk full'); }, resolveSessionDirectory: async () => { throw new Error('upstream unavailable'); } });
    await f.runtime.accept(event());
    await expect(f.runtime.retry('session', '/destination')).rejects.toThrow('upstream unavailable');
    expect(f.runtime.snapshot().moves).toEqual([{ sessionId: 'session', directory: '/destination', status: 'failed' }]);
  });

  it('rejects late work from A to B after the move from B to C', async () => {
    let finish;
    const f = fixture({ listWorktrees: vi.fn(d => d === '/b' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve([])) });
    const older = f.runtime.accept(event('/b', 'session', 1));
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await f.runtime.accept(event('/c', 'session', 2));
    finish([]);
    await older;
    await f.runtime.accept(event('/b', 'session', 1));
    expect(f.projects.map(p => p.path)).toEqual(['/source', '/c']);
    expect(f.runtime.snapshot().moves).toEqual([{ sessionId: 'session', directory: '/c', status: 'registered' }]);
  });

  it('does not restore a failed target after moving back to chats or deleting the session', async () => {
    const f = fixture({ persistProjectRegistration: vi.fn(async () => { throw new Error('disk full'); }) });
    await f.runtime.accept(event());
    await f.runtime.accept(event('/chats/new', 'session', 2));
    await f.runtime.accept(event());
    expect(f.runtime.snapshot()).toEqual({ moves: [] });
    expect(f.deps.persistProjectRegistration).toHaveBeenCalledTimes(1);
    await f.runtime.accept(event('/destination', 'session', 3));
    await f.runtime.accept({ payload: { ...event('/destination', 'session', 4).payload, type: 'session.deleted' } });
    expect(f.runtime.snapshot()).toEqual({ moves: [] });
  });

  it('deduplicates moves that share a timestamp without assuming event IDs sort by time', async () => {
    const f = fixture();
    const first = event('/one');
    const next = { payload: { ...event('/two').payload, id: 'different-id-at-the-same-time' } };
    await f.runtime.accept(first);
    await f.runtime.accept(next);
    await f.runtime.accept(first);
    expect(f.deps.validateDirectoryPath).toHaveBeenCalledTimes(2);
    expect(f.runtime.snapshot().moves).toEqual([{ sessionId: 'session', directory: '/two', status: 'registered' }]);
  });
});

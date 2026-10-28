import { describe, expect, test } from 'bun:test';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { opencodeClient } from '@/lib/opencode/client';
import { useSessionUIStore } from './session-ui-store';
import { subscribeSessionMoveProjects } from './session-move-projects';

type IO = NonNullable<Parameters<typeof subscribeSessionMoveProjects>[2]>;
type Snapshot = Awaited<ReturnType<IO['load']>>;
const failed: Snapshot = { moves: [{ sessionId: 'background', directory: '/destination', status: 'failed' }] };
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const fixture = () => {
  let event: Parameters<IO['subscribe']>[0] = () => {};
  let runtimeChanged = () => {};
  let runtime = 'a';
  const io: IO = {
    runtimeKey: () => runtime,
    subscribe: (listener) => { event = listener; return () => { event = () => {}; }; },
    onRuntimeChange: (listener) => { runtimeChanged = listener; return () => { runtimeChanged = () => {}; }; },
    load: async () => ({ moves: [] }),
    retry: async () => {},
  };
  return {
    io,
    ready: () => event({ type: 'event-stream-ready', connectionId: 'connection' }),
    changed: () => event({ type: 'session-move-projects-changed' }),
    switchTo: (key: string) => { runtime = key; runtimeChanged(); },
  };
};

describe('session move project synchronization', () => {
  for (const scenario of [
    { name: 'historical moves preserve a manually selected sidebar project', known: true, early: false, contextChanged: false, singleBefore: 'manual', singleAfter: 'manual' },
    { name: 'a newly registered foreground owner follows the previous project', known: false, early: false, contextChanged: false, singleBefore: 'source', singleAfter: 'destination' },
    { name: 'delayed registration preserves a newer manual sidebar project', known: false, early: false, contextChanged: false, singleBefore: 'manual', singleAfter: 'manual' },
    { name: 'another settings read can register the owner before the move refresh', known: false, early: true, contextChanged: false, singleBefore: 'source', singleAfter: 'destination' },
    { name: 'a newer project context cancels deferred foreground navigation', known: false, early: true, contextChanged: true, singleBefore: 'manual', singleAfter: 'manual' },
    { name: 'bootstrap snapshots do not cancel a foreground move', known: false, early: false, contextChanged: false, bootstrapping: true, singleBefore: 'source', singleAfter: 'destination' },
    { name: 'a manual sidebar choice after bootstrap still wins', known: false, early: false, contextChanged: false, bootstrapping: true, singleBefore: 'manual', singleAfter: 'manual' },
    { name: 'directory-only navigation cancels deferred foreground resolution', known: false, early: true, contextChanged: false, directoryOnly: true, singleBefore: 'source', singleAfter: 'source' },
  ]) {
    test(scenario.name, async () => {
      const { known, early, contextChanged, bootstrapping = false, directoryOnly = false, singleBefore, singleAfter } = scenario;
      const f = fixture();
      const previous = { projects: useProjectsStore.getState(), directory: useDirectoryStore.getState(),
        display: useSessionDisplayStore.getState(), ui: useSessionUIStore.getState(), sdkDirectory: opencodeClient.getDirectory() };
      const source = { id: 'source', path: '/source' };
      const manual = { id: 'manual', path: '/manual' };
      const destination = { id: 'destination', path: '/destination' };
      useProjectsStore.setState({ projects: bootstrapping ? [] : [source, manual, ...(known ? [destination] : [])],
        activeProjectId: bootstrapping ? null : known ? 'destination' : 'source', hasServerSnapshot: !bootstrapping });
      useDirectoryStore.setState({ currentDirectory: known ? '/destination' : '/source' });
      useSessionDisplayStore.setState({ singleProjectId: bootstrapping ? null : known ? singleBefore : 'source' });
      useSessionUIStore.setState({ currentSessionId: 'foreground', currentSessionDirectory: known ? '/destination' : '/source',
        newSessionDraft: { ...previous.ui.newSessionDraft, open: false }, availableWorktreesByProject: new Map() });
      opencodeClient.setDirectory(known ? '/destination' : '/source');
      if (!known) useSessionUIStore.getState().setSessionDirectory('foreground', '/destination');
      if (bootstrapping) {
        useProjectsStore.setState({ projects: [source, manual], activeProjectId: 'source', hasServerSnapshot: true });
        useDirectoryStore.getState().setDirectory('/source', { source: 'bootstrap', showOverlay: false });
        useSessionDisplayStore.setState({ singleProjectId: 'source' });
      }
      if (singleBefore === 'manual') useSessionDisplayStore.getState().setSingleProjectId('manual');
      if (early) useProjectsStore.setState({ projects: [source, manual, destination] });
      if (contextChanged) {
        useProjectsStore.getState().setActiveProjectIdOnly('manual');
      }
      if (directoryOnly) useDirectoryStore.getState().setDirectory('/source', { showOverlay: false });
      f.io.load = async () => {
        useProjectsStore.setState({ projects: [source, manual, destination, { id: 'background', path: '/background' }] });
        return { moves: [
          { sessionId: 'foreground', directory: '/destination', status: 'registered' },
          { sessionId: 'background', directory: '/background', status: 'registered' },
        ] };
      };
      const stop = subscribeSessionMoveProjects('a', () => () => {}, f.io);
      try {
        await settle();
        expect(useProjectsStore.getState().activeProjectId).toBe(contextChanged ? 'manual' : directoryOnly ? 'source' : 'destination');
        expect(useSessionDisplayStore.getState().singleProjectId).toBe(singleAfter);
        expect(useDirectoryStore.getState().currentDirectory).toBe(directoryOnly ? '/source' : '/destination');
        expect(opencodeClient.getDirectory()).toBe(directoryOnly ? '/source' : '/destination');
        expect(useSessionUIStore.getState().currentSessionId).toBe('foreground');
      } finally {
        stop();
        useSessionUIStore.getState().setCurrentSession(null);
        useProjectsStore.setState(previous.projects, true); useDirectoryStore.setState(previous.directory, true);
        useSessionDisplayStore.setState(previous.display, true); useSessionUIStore.setState(previous.ui, true);
        opencodeClient.setDirectory(previous.sdkDirectory);
      }
    });
  }

  test('rebuilding a subscriber restores an outstanding failure without another stream-ready event', async () => {
    const f = fixture();
    f.io.load = async () => failed;
    let notices = 0;
    let dismissals = 0;
    const subscribe = () => subscribeSessionMoveProjects('a', () => {
      notices += 1;
      return () => { dismissals += 1; };
    }, f.io);
    const first = subscribe();
    await settle();
    expect(notices).toBe(1);
    first();
    const second = subscribe();
    try {
      await settle();
      expect(notices).toBe(2);
      expect(dismissals).toBe(1);
    } finally { second(); }
  });

  test('a reconnect exposes an offline failure once and a successful retry dismisses it', async () => {
    const f = fixture();
    let snapshot = failed;
    let notices = 0;
    let dismissals = 0;
    let retries = 0;
    let retry = () => {};
    f.io.load = async () => snapshot;
    f.io.retry = async () => { retries += 1; snapshot = { moves: [] }; };
    const stop = subscribeSessionMoveProjects('a', (move, action) => {
      expect(move.directory).toBe('/destination'); notices += 1; retry = action;
      return () => { dismissals += 1; };
    }, f.io);
    try {
      f.ready(); await settle();
      f.changed(); await settle();
      expect(notices).toBe(1);
      retry(); await settle(); await settle();
      expect(retries).toBe(1);
      expect(dismissals).toBe(1);
    } finally { stop(); }
  });

  test('a response from before A to B to A cannot apply or show a failure', async () => {
    const f = fixture();
    let finish: (value: Snapshot) => void = () => {};
    f.io.load = () => new Promise(resolve => { finish = resolve; });
    let notices = 0;
    const stop = subscribeSessionMoveProjects('a', () => { notices += 1; return () => {}; }, f.io);
    try {
      f.ready();
      f.switchTo('b'); f.switchTo('a');
      finish(failed); await settle();
      expect(notices).toBe(0);
    } finally { stop(); }
  });

  test('coalesces invalidations during a read and then reads fresh authority', async () => {
    const f = fixture();
    let finish: (value: Snapshot) => void = () => {};
    let reads = 0;
    f.io.load = () => ++reads === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(failed);
    let notices = 0;
    const stop = subscribeSessionMoveProjects('a', () => { notices += 1; return () => {}; }, f.io);
    try {
      f.ready(); f.changed(); f.changed();
      expect(reads).toBe(1);
      finish({ moves: [] }); await settle();
      expect(reads).toBe(2);
      expect(notices).toBe(1);
    } finally { stop(); }
  });

  test('a failed reconnect read preserves the existing registry and recovers on the next signal', async () => {
    const f = fixture();
    const previous = useProjectsStore.getState();
    const projects = [{ id: 'kept', path: '/kept', label: 'Keep this' }];
    useProjectsStore.setState({ projects, activeProjectId: 'kept' });
    f.io.load = async () => { throw new Error('offline'); };
    let notices = 0;
    const stop = subscribeSessionMoveProjects('a', () => { notices += 1; return () => {}; }, f.io);
    try {
      f.ready(); await settle();
      expect(useProjectsStore.getState().projects).toBe(projects);
      expect(useProjectsStore.getState().activeProjectId).toBe('kept');
      expect(notices).toBe(0);
      f.io.load = async () => failed;
      f.ready(); await settle();
      expect(notices).toBe(1);
    } finally { stop(); useProjectsStore.setState(previous, true); }
  });

  test('disposing rejects a pending read and an old failure action cannot retry in a new runtime', async () => {
    const f = fixture();
    let retries = 0;
    let action = () => {};
    f.io.load = async () => failed;
    f.io.retry = async () => { retries += 1; };
    let notices = 0;
    const stop = subscribeSessionMoveProjects('a', (_move, retry) => {
      notices += 1; action = retry; return () => {};
    }, f.io);
    f.ready(); await settle();
    f.switchTo('b'); f.switchTo('a');
    action(); await settle();
    expect(retries).toBe(0);
    let finish: (value: Snapshot) => void = () => {};
    f.io.load = () => new Promise(resolve => { finish = resolve; });
    f.ready(); stop(); finish(failed); await settle();
    expect(notices).toBe(1);
  });
});

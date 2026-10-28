import { afterEach, describe, expect, test } from "bun:test"
import { GLOBAL_EVENT_DIRECTORY, type SyncEvent } from "@/lib/opencode/events"
import type { Message, Part, Session } from "@/lib/opencode/model"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { useProjectsStore } from "@/stores/useProjectsStore"
import { useDirectoryStore } from "@/stores/useDirectoryStore"
import { useSessionDisplayStore } from "@/stores/useSessionDisplayStore"
import { opencodeClient } from "@/lib/opencode/client"
import { useSessionUIStore } from "../session-ui-store"
import { ChildStoreManager } from "../child-store"
import { setActionRefs } from "../session-actions"
import { SessionMessageLoader, setImperativeSessionMessageLoader } from "../session-message-loader"
import { createEventRoutingIndex, handleEvent } from "../sync-context"

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

// Directory stores persist their session lists, so each test gets its own pair.
let run = 0
let from = ""
let to = ""

const session = (): Session => ({
  id: "ses_1",
  projectID: "prj_old",
  directory: from,
  title: "Moving",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
})
const user: Message = { id: "msg_u", sessionID: "ses_1", role: "user", time: { created: 1 } }
const text: Part = { id: "prt_u", messageID: "msg_u", sessionID: "ses_1", type: "text", text: "hi" }

// What `translateWireEvent` makes of OpenCode's `session.moved`.
const movedEvents = (): SyncEvent[] => [
  {
    type: "session.patched",
    properties: { sessionID: "ses_1", patch: { directory: to, projectID: "prj_new", subpath: null, time: { updated: 5 } } },
  },
  {
    type: "message.updated",
    properties: { info: { id: "msg_moved", sessionID: "ses_1", role: "location-switched", time: { created: 5 }, directory: to } },
  },
]

function setup() {
  run += 1
  from = `/moved-${run}/old`
  to = `/moved-${run}/new`
  const childStores = new ChildStoreManager()
  const source = childStores.ensureChild(from, { bootstrap: false })
  const destination = childStores.ensureChild(to, { bootstrap: false })
  source.setState({
    session: [session()],
    sessionTotal: 1,
    session_status: { ses_1: { type: "idle" } },
    message: { ses_1: [user] },
    part: { msg_u: [text] },
  })
  const routingIndex = createEventRoutingIndex()
  setActionRefs(childStores, () => from)
  cleanups.push(() => childStores.disposeAll())
  const receive = (directory: string, event: SyncEvent) => (
    handleEvent(directory, event, childStores, routingIndex, getRuntimeKey())
  )
  return { childStores, source, destination, receive, routingIndex }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("session.moved", () => {
  test("updates an unopened background session without creating directory stores", () => {
    run += 1
    from = `/moved-${run}/unopened`
    to = `/moved-${run}/destination`
    const childStores = new ChildStoreManager()
    setActionRefs(childStores, () => from)
    useGlobalSessionsStore.getState().upsertSession(session())
    cleanups.push(() => { childStores.disposeAll(); useGlobalSessionsStore.getState().removeSessions(["ses_1"]) })
    const routingIndex = createEventRoutingIndex()
    handleEvent(from, movedEvents()[0], childStores, routingIndex, getRuntimeKey())
    expect(useGlobalSessionsStore.getState().entityById.get("ses_1")?.directory).toBe(to)
    expect(childStores.getChild(from)).toBeUndefined()
    expect(childStores.getChild(to)).toBeUndefined()
  })

  test("the current chat follows its destination and project without selecting a different session", () => {
    const { receive } = setup()
    const ui = useSessionUIStore.getState()
    const projects = useProjectsStore.getState()
    const directory = useDirectoryStore.getState()
    const display = useSessionDisplayStore.getState()
    const sdkDirectory = opencodeClient.getDirectory()
    cleanups.push(() => {
      useSessionUIStore.setState(ui, true); useProjectsStore.setState(projects, true)
      useDirectoryStore.setState(directory, true); useSessionDisplayStore.setState(display, true)
      opencodeClient.setDirectory(sdkDirectory)
    })
    useProjectsStore.setState({ projects: [{ id: "old", path: from }, { id: "new", path: to }], activeProjectId: "old" })
    useSessionUIStore.setState({ currentSessionId: "ses_1", currentSessionDirectory: from, newSessionDraft: { ...ui.newSessionDraft, open: false } })
    receive(from, movedEvents()[0])
    expect(useSessionUIStore.getState().currentSessionId).toBe("ses_1")
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe(to)
    expect(useDirectoryStore.getState().currentDirectory).toBe(to)
    expect(opencodeClient.getDirectory()).toBe(to)
    expect(useProjectsStore.getState().activeProjectId).toBe("new")
    expect(useSessionDisplayStore.getState().singleProjectId).toBe("new")
  })

  test("the current chat follows a move before its source directory store has loaded", () => {
    run += 1
    from = `/moved-${run}/unloaded-current`
    to = `/moved-${run}/destination`
    const childStores = new ChildStoreManager()
    const ui = useSessionUIStore.getState()
    const projects = useProjectsStore.getState()
    const directory = useDirectoryStore.getState()
    const display = useSessionDisplayStore.getState()
    const sdkDirectory = opencodeClient.getDirectory()
    cleanups.push(() => {
      childStores.disposeAll(); useGlobalSessionsStore.getState().removeSessions(["ses_1"])
      useSessionUIStore.setState(ui, true); useProjectsStore.setState(projects, true)
      useDirectoryStore.setState(directory, true); useSessionDisplayStore.setState(display, true)
      opencodeClient.setDirectory(sdkDirectory)
    })
    setActionRefs(childStores, () => from)
    useGlobalSessionsStore.getState().upsertSession(session())
    useProjectsStore.setState({ projects: [{ id: "old", path: from }, { id: "new", path: to }], activeProjectId: "old" })
    useSessionUIStore.setState({ currentSessionId: "ses_1", currentSessionDirectory: from, newSessionDraft: { ...ui.newSessionDraft, open: false } })
    useDirectoryStore.setState({ currentDirectory: from })
    opencodeClient.setDirectory(from)

    handleEvent(from, movedEvents()[0], childStores, createEventRoutingIndex(), getRuntimeKey())

    expect(useSessionUIStore.getState().currentSessionId).toBe("ses_1")
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe(to)
    expect(useDirectoryStore.getState().currentDirectory).toBe(to)
    expect(opencodeClient.getDirectory()).toBe(to)
    expect(useProjectsStore.getState().activeProjectId).toBe("new")
    expect(useSessionDisplayStore.getState().singleProjectId).toBe("new")
    expect(childStores.getChild(from)).toBeUndefined()
    expect(childStores.getChild(to)).toBeUndefined()
  })

  test("moving a background chat leaves a no-project draft and current directory alone", () => {
    const { receive } = setup()
    const ui = useSessionUIStore.getState()
    const projects = useProjectsStore.getState()
    const directory = useDirectoryStore.getState()
    const sdkDirectory = opencodeClient.getDirectory()
    cleanups.push(() => {
      useSessionUIStore.setState(ui, true); useProjectsStore.setState(projects, true)
      useDirectoryStore.setState(directory, true); opencodeClient.setDirectory(sdkDirectory)
    })
    const draft = { ...ui.newSessionDraft, open: true }
    useProjectsStore.setState({ activeProjectId: null })
    useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: "/draft", newSessionDraft: draft })
    useDirectoryStore.setState({ currentDirectory: "/draft" })
    opencodeClient.setDirectory("/draft")
    receive(from, movedEvents()[0])
    expect(useSessionUIStore.getState().newSessionDraft).toBe(draft)
    expect(useSessionUIStore.getState().currentSessionId).toBeNull()
    expect(useDirectoryStore.getState().currentDirectory).toBe("/draft")
    expect(opencodeClient.getDirectory()).toBe("/draft")
    expect(useProjectsStore.getState().activeProjectId).toBeNull()
  })

  test("carries the session and its transcript to the destination store", () => {
    const { source, destination, receive } = setup()

    for (const event of movedEvents()) receive(to, event)

    expect(source.getState().session).toHaveLength(0)
    expect(source.getState().message.ses_1).toBe(undefined)
    expect(source.getState().part.msg_u).toBe(undefined)
    expect(destination.getState().session[0]).toMatchObject({ id: "ses_1", directory: to, projectID: "prj_new" })
    expect(destination.getState().sessionTotal).toBe(1)
    expect(destination.getState().session_status.ses_1?.type).toBe("idle")
    expect(destination.getState().message.ses_1?.map((message) => message.id)).toEqual(["msg_u", "msg_moved"])
    expect(destination.getState().part.msg_u?.[0]?.id).toBe("prt_u")
  })

  test("routes the next turn into the store the chat now reads", () => {
    const { source, destination, receive } = setup()
    for (const event of movedEvents()) receive(to, event)

    const next: Message = { id: "msg_next", sessionID: "ses_1", role: "user", time: { created: 6 } }
    receive(to, { type: "message.updated", properties: { info: next } })

    expect(destination.getState().message.ses_1?.at(-1)?.id).toBe("msg_next")
    expect(source.getState().message.ses_1).toBe(undefined)
  })

  // Recorded from OpenCode 2.1.4: `session.moved` is tagged with the directory
  // the session left, and the `permission.asked` that follows carries no
  // location. The old directory's store gets a copy of the session back only
  // when that directory is read again later (a stream reconnect, opening it),
  // and that read indexes the session there again; the copy below models it.
  test("a permission asked after the move lands where the chat reads", () => {
    const { source, destination, receive, routingIndex } = setup()
    useGlobalSessionsStore.getState().upsertSession(session())
    cleanups.push(() => useGlobalSessionsStore.getState().removeSessions(["ses_1"]))

    for (const event of movedEvents()) receive(from, event)
    source.setState({ session: [{ ...session(), directory: to }], message: { ses_1: [user] } })
    routingIndex.sessionDirectoryById.set("ses_1", from)
    receive(GLOBAL_EVENT_DIRECTORY, {
      type: "permission.asked",
      properties: { id: "per_1", sessionID: "ses_1", action: "edit", resources: ["/outside/note.txt"], metadata: {} },
    })

    expect(destination.getState().permission.ses_1?.map((request) => request.id)).toEqual(["per_1"])
    expect(source.getState().permission.ses_1).toBe(undefined)
  })

  test("drops the transcript and live state other stores kept of the session", () => {
    const { receive, childStores } = setup()
    const elsewhere = childStores.ensureChild(`/moved-${run}/other`, { bootstrap: false })
    elsewhere.setState({
      session: [session()],
      session_status: { ses_1: { type: "busy" } },
      message: { ses_1: [user] },
      part: { msg_u: [text] },
    })

    for (const event of movedEvents()) receive(from, event)

    expect(elsewhere.getState().message.ses_1).toBe(undefined)
    expect(elsewhere.getState().part.msg_u).toBe(undefined)
    expect(elsewhere.getState().session_status.ses_1).toBe(undefined)
    // A parent repository lists its worktrees' sessions; the list is not live state.
    expect(elsewhere.getState().session.map((candidate) => candidate.id)).toEqual(["ses_1"])
  })

  test("drops parts of the session filed under a message that store does not list", () => {
    const { receive, childStores } = setup()
    const elsewhere = childStores.ensureChild(`/moved-${run}/other`, { bootstrap: false })
    const orphan: Part = { id: "prt_o", messageID: "msg_o", sessionID: "ses_1", type: "text", text: "streamed" }
    const unrelated: Part = { id: "prt_x", messageID: "msg_x", sessionID: "ses_2", type: "text", text: "kept" }
    elsewhere.setState({
      session_status: { ses_1: { type: "busy" } },
      message: { ses_1: [user] },
      part: { msg_u: [text], msg_o: [orphan], msg_x: [unrelated] },
    })

    for (const event of movedEvents()) receive(from, event)

    // A part event can land before the message it belongs to.
    expect(elsewhere.getState().part.msg_o).toBe(undefined)
    expect(elsewhere.getState().part.msg_u).toBe(undefined)
    expect(elsewhere.getState().part.msg_x).toEqual([unrelated])
  })

  test("drops a part of the session that is all a store holds of it, the store it left included", () => {
    const { receive, childStores, source } = setup()
    const elsewhere = childStores.ensureChild(`/moved-${run}/other`, { bootstrap: false })
    const orphan: Part = { id: "prt_o", messageID: "msg_o", sessionID: "ses_1", type: "text", text: "streamed" }
    elsewhere.setState({ part: { msg_o: [orphan] } })
    source.setState({ part: { ...source.getState().part, msg_o: [orphan] } })

    for (const event of movedEvents()) receive(from, event)

    expect(elsewhere.getState().part.msg_o).toBe(undefined)
    expect(source.getState().part.msg_o).toBe(undefined)
  })

  test("a request another store held follows the session instead of vanishing", () => {
    const { receive, childStores, destination } = setup()
    const elsewhere = childStores.ensureChild(`/moved-${run}/other`, { bootstrap: false })
    const request = { id: "per_1", sessionID: "ses_1", action: "edit", resources: [], metadata: {} }
    elsewhere.setState({ permission: { ses_1: [request] } })

    for (const event of movedEvents()) receive(from, event)

    expect(elsewhere.getState().permission.ses_1).toBe(undefined)
    expect(destination.getState().permission.ses_1?.map((pending) => pending.id)).toEqual(["per_1"])
  })

  test("a second delivery of the same move changes nothing", () => {
    const { destination, receive } = setup()
    for (const event of movedEvents()) receive(to, event)
    const after = destination.getState()

    receive(from, movedEvents()[0])

    expect(destination.getState().session).toBe(after.session)
    expect(destination.getState().message).toBe(after.message)
  })

  test("a recovery asked for in the directory it left reads into the one it moved to", async () => {
    const { childStores, source, receive } = setup()
    const reads: string[] = []
    const loader = new SessionMessageLoader(childStores, {
      sdk: { getSessionMessages: async (_id, _options, directory) => { reads.push(directory ?? ""); return { items: [], cursor: {} } } },
      runtimeKey: getRuntimeKey(),
    })
    setImperativeSessionMessageLoader(loader)
    cleanups.push(() => { setImperativeSessionMessageLoader(null); loader.dispose() })
    // The global list takes the new directory from the same event.
    useGlobalSessionsStore.getState().upsertSession({ ...session(), directory: to })
    cleanups.push(() => useGlobalSessionsStore.getState().removeSessions(["ses_1"]))
    const patchUnknown = (messageID: string): SyncEvent => ({
      type: "message.patched",
      properties: { sessionID: "ses_1", messageID, patch: { time: { completed: 6 } } },
    })

    // OpenCode reports the move's own steps in the old directory, in the same
    // flush as the move: the recovery they ask for runs after the move.
    receive(from, patchUnknown("msg_old"))
    for (const event of movedEvents()) receive(to, event)
    await settle()

    expect(reads).toEqual([to])
    expect(source.getState().session).toHaveLength(0)
    expect(source.getState().message.ses_1).toBe(undefined)
  })
})

/*
 * S04 — the native macOS process observer the host executor records descendants through.
 *
 * A managed command is started as its own process group, so a same-group child is stopped with the
 * group signal. A child that left the group (a daemonizing double-fork, or a script that spawned a
 * detached process) cannot be reached by that signal at all, and no stdio trick can stand in for a
 * process table: Node's `close` event fires when the direct child's pipes are done, not when the
 * grandchild dies. A restricted runtime can also deny `ps` (spawn EPERM) and `pgrep` (no process
 * list), so the executor carries its own enumeration through Darwin `libproc` and reports the
 * survivors it can see instead of claiming a stop it cannot prove.
 *
 * Contract with packages/security/src/execution/process-table.ts (identical to the bootstrap in
 * packages/security/src/execution/native/exec-observation.c):
 *
 *   echopilot-exec-observation ps
 *
 * prints one line per visible process, whitespace separated:
 *
 *   <pid> <ppid> <pgid> <pbi_status>
 *
 * where `pbi_status` is 1 SIDL, 2 SRUN, 3 SSLEEP, 4 SSTOP, 5 SZOMB. Processes this uid may not
 * inspect are skipped rather than guessed at. Exit status is 0 on success, 1 when libproc refuses,
 * and 2 on a usage error.
 */
import Foundation

/// One visible process: the pid, its parent, its process group, and its Darwin `pbi_status`.
struct ObservedProcess {
    let pid: pid_t
    let parent: pid_t
    let group: pid_t
    let status: UInt32
}

/// `proc_listallpids` is called twice on purpose: once for the capacity, once for the list. A
/// process may exit between the calls, so the second call's byte count — not the capacity — is what
/// bounds the returned list.
func listAllPids() -> [pid_t]? {
    let capacity = proc_listallpids(nil, 0)
    guard capacity > 0 else { return nil }
    var pids = [pid_t](repeating: 0, count: Int(capacity) + 64)
    let bytes = pids.withUnsafeMutableBufferPointer { buffer -> Int32 in
        guard let base = buffer.baseAddress else { return 0 }
        return proc_listallpids(base, Int32(buffer.count * MemoryLayout<pid_t>.size))
    }
    guard bytes > 0 else { return nil }
    return Array(pids[0 ..< Int(bytes) / MemoryLayout<pid_t>.size])
}

/// The process table, or `nil` when libproc refuses to enumerate: the caller must then report an
/// unverified stop instead of an empty table that would look like a clean one.
func processTable() -> [ObservedProcess]? {
    guard let pids = listAllPids() else { return nil }
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    var table: [ObservedProcess] = []
    table.reserveCapacity(pids.count)
    for pid in pids where pid > 0 {
        var info = proc_bsdinfo()
        let read = withUnsafeMutablePointer(to: &info) { pointer -> Int32 in
            proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, pointer, size)
        }
        // Anything but a full record (a process that exited, or one this uid may not inspect) is
        // skipped rather than reported with guessed fields.
        guard read == size else { continue }
        table.append(ObservedProcess(
            pid: pid,
            parent: pid_t(info.pbi_ppid),
            group: pid_t(info.pbi_pgid),
            status: UInt32(info.pbi_status)
        ))
    }
    return table
}

func fail(_ message: String, _ code: Int32) -> Never {
    FileHandle.standardError.write(Data("echopilot-exec-observation: \(message)\n".utf8))
    exit(code)
}

let arguments = CommandLine.arguments
guard arguments.count == 2, arguments[1] == "ps" else {
    fail("usage: echopilot-exec-observation ps", 2)
}
guard let table = processTable() else {
    fail("proc_listallpids failed", 1)
}
var output = ""
output.reserveCapacity(table.count * 24)
for entry in table {
    output += "\(entry.pid) \(entry.parent) \(entry.group) \(entry.status)\n"
}
FileHandle.standardOutput.write(Data(output.utf8))

/*
 * S04 process observation bootstrap — the minimal Darwin `libproc` reader the host executor
 * compiles when no prebuilt helper is available.
 *
 * Why this exists: a managed runtime can deny `ps` (spawn EPERM) and `pgrep` (no process list), so
 * an executor that only looked for those tools could not tell a same-group child from an escaped
 * one and would have to guess. `proc_listallpids` plus `proc_pidinfo(PROC_PIDTBSDINFO)` answer
 * from libproc directly, with the parent, the process group, and the process state the stop
 * report needs.
 *
 * Contract with `process-table.ts` (identical to the Swift helper in
 * `native/macos/Sources/Execution`, which is the shipped form of the same reader):
 *
 *   exec-observation ps
 *
 * prints one line per visible process, whitespace separated:
 *
 *   <pid> <ppid> <pgid> <pbi_status>
 *
 * where `pbi_status` is 1 SIDL, 2 SRUN, 3 SSLEEP, 4 SSTOP, 5 SZOMB. Processes this uid may not
 * inspect are skipped rather than guessed at. Exit status is 0 on success, 1 when libproc refuses,
 * and 2 on a usage error.
 */
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int print_process_table(void) {
  int capacity = proc_listallpids(NULL, 0);
  if (capacity <= 0) {
    fprintf(stderr, "exec-observation: proc_listallpids failed (%d)\n", capacity);
    return 1;
  }
  capacity += 64;
  pid_t *pids = (pid_t *)calloc((size_t)capacity, sizeof(pid_t));
  if (pids == NULL) {
    fprintf(stderr, "exec-observation: out of memory\n");
    return 1;
  }
  int bytes = proc_listallpids(pids, capacity * (int)sizeof(pid_t));
  if (bytes <= 0) {
    fprintf(stderr, "exec-observation: proc_listallpids(buffer) failed (%d)\n", bytes);
    free(pids);
    return 1;
  }
  int count = bytes / (int)sizeof(pid_t);
  for (int index = 0; index < count; index++) {
    pid_t pid = pids[index];
    if (pid <= 0) continue;
    struct proc_bsdinfo info;
    memset(&info, 0, sizeof(info));
    int got = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, (int)sizeof(info));
    if (got != (int)sizeof(info)) continue;
    printf("%d %d %d %d\n", (int)pid, (int)info.pbi_ppid, (int)info.pbi_pgid, (int)info.pbi_status);
  }
  free(pids);
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "ps") == 0) return print_process_table();
  fprintf(stderr, "usage: exec-observation ps\n");
  return 2;
}

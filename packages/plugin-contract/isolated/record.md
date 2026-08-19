# Isolated protocol-fixture allowlists

These files are the recorded syscall / AppContainer allowlists for Isolated
Worker spawn. They are **not** hand-waved empty stubs. Isolated seccomp and
seatbelt must allow **only** names listed here.

Default lists are recorded **without** a `network.fetch` grant. They must not
contain `socket`, `connect`, `accept`, or `bind`. A later grant may add those
names; do not put them in the default files.

## Fixture

Replay `packages/plugin-contract/fixtures/protocol/initialize-activate-ping.jsonl`
under Full Trust first, using the Host-managed runtime:

| Runtime | Lock |
| --- | --- |
| Node | Host Node 22.22.3 |
| Python | Host CPython 3.12.11 (`python-build-standalone` install_only) |
| Native | package `hello` worker for the current triple |

Record only the syscalls that succeed while the Worker reaches `initialized`,
answers `activate`, answers `ping`, invokes `hello`, and `dispose`s. Drop
failed probe calls (ENOENT / ENOSYS) unless a later Isolated run actually
needs them to start.

## Linux (`strace`)

```sh
strace -f -e trace=all -o raw.strace -- \
  "$RUNTIME_BIN" $WORKER_ARGS
```

Normalize:

1. Take the syscall name before `(` on each line.
2. Drop the `pid` prefix `strace -f` adds.
3. Sort uniquely into `node.linux.syscalls`, `python.linux.syscalls`, or
   `native.linux.syscalls`.
4. Reject the recording if it contains `socket`, `connect`, `accept`, or
   `bind`. Those appear only after a `network.fetch` grant.
5. Keep interpreter startup names: `openat`, `newfstatat`, `mmap`, `munmap`,
   `ioctl`, `fcntl`, `pipe` / `pipe2`, `epoll_*`, `rt_sigaction`, `prctl`,
   `clone` (never `CLONE_NEWUSER`), `read`, `write`, `close`, `exit_group`,
   `futex`, `brk`, `mprotect`, `access`, `statx`, `getcwd`, `lseek`,
   `pread64`, `clock_gettime`, `getrandom`, `nanosleep`, `wait4`, `execve`.

Host Isolated spawn on Linux is `bwrap --unshare-net` plus read-only binds of
the package and runtime and a writable tmp. Do **not** record under
`unshare --map-root-user`; that is Full Trust-like, not Isolated.

## macOS (`dtruss` / `sandbox-exec`)

```sh
sudo dtruss -f "$RUNTIME_BIN" $WORKER_ARGS
# or
sandbox-exec -D -f isolated.sb "$RUNTIME_BIN" $WORKER_ARGS
```

Normalize BSD syscall names into `*.darwin.syscalls`. Keep `kqueue`,
`kevent`, `mmap`, `open`, `read`, `write`, `close`, `fcntl`, `ioctl`,
`mprotect`, `stat64`, `getdirentries`, `posix_spawn`, `fork`, `execve`.
Reject `connect`, `bind`, and `accept`.

## Windows (AppContainer)

Default `*.windows.caps` files stay empty of capability names. Isolated
AppContainer profiles must not include `internetClient` unless the package
has a `network.fetch` grant. Job limits (`KILL_ON_JOB_CLOSE`, 256 MiB) are
Host policy, not capability names.

## Review before merging a new recording

- Lists are non-empty and one name per line.
- Required interpreter names above are present.
- Default files still omit `socket` / `connect` / `accept` / `bind` and
  Windows `internetClient`.
- CI then re-runs the same fixture under Isolated and asserts the Worker
  reaches `initialized` without SIGSYS or a seatbelt `openat` denial.

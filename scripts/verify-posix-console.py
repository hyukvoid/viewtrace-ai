"""Release test: real controlling terminal Ctrl+C, not child.kill(SIGINT)."""
import errno, fcntl, json, os, pty, select, signal, sys, termios, time

node, cli, root, producer, ready = sys.argv[1:]
master, slave = pty.openpty()
pid = os.fork()
if pid == 0:
    os.close(master)
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    for fd in (0, 1, 2): os.dup2(slave, fd)
    os.close(slave)
    os.execv(node, [node, cli, 'run', '--data-root', root, '--json', '--', node, producer, '--hold'])
os.close(slave)
output = bytearray()
sent = False
deadline = time.monotonic() + 45
status = None
try:
    while time.monotonic() < deadline:
        if not sent and os.path.exists(ready):
            os.write(master, b'\x03')  # terminal driver delivers SIGINT to the foreground process group
            sent = True
        readable, _, _ = select.select([master], [], [], 0.1)
        if readable:
            try:
                chunk = os.read(master, 65536)
                if chunk: output.extend(chunk)
            except OSError as e:
                if e.errno != errno.EIO: raise
        ended, exit_status = os.waitpid(pid, os.WNOHANG)
        if ended:
            status = os.waitstatus_to_exitcode(exit_status)
            break
    if status is None: raise RuntimeError('console cancellation timeout')
    print(output.decode('utf8', errors='replace'))
    if not sent or status != 130: raise RuntimeError(f'real Ctrl+C did not produce wrapper exit130: sent={sent}, exit={status}')
    print(json.dumps({'consoleCtrlC': True, 'exitCode': status}))
finally:
    if status is None:
        try: os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError: pass
        os.waitpid(pid, 0)
    os.close(master)

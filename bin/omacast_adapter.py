#!/usr/bin/env python3
"""One-shot optional adapters. No shell expansion and no background service."""
import contextlib
import http.client
import json
import math
import os
import selectors
import signal
import stat
import subprocess
import sys
import tempfile
import time
import urllib.parse
import threading
import socket

LIMIT = 65536
CANCELLED = False


def cancel_signal(signum, frame):
    global CANCELLED
    CANCELLED = True


def run(argv, timeout=60, cwd="/", limit=LIMIT, environment=None):
    if not argv or not all(isinstance(v, str) and v and '\0' not in v for v in argv):
        raise ValueError("Invalid command")
    try:
        proc = subprocess.Popen(argv, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                start_new_session=True, stdin=subprocess.DEVNULL, env=environment)
    except FileNotFoundError:
        raise ValueError("Missing helper: " + argv[0])
    streams = selectors.DefaultSelector()
    streams.register(proc.stdout, selectors.EVENT_READ, 0)
    streams.register(proc.stderr, selectors.EVENT_READ, 1)
    output = [bytearray(), bytearray()]
    deadline = time.monotonic() + timeout
    state = None
    drain_deadline = None
    try:
        while streams.get_map():
            now = time.monotonic()
            if state is None:
                state = os.waitid(os.P_PID, proc.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                if state is not None:
                    drain_deadline = now + .05
            if drain_deadline is not None and now >= drain_deadline:
                break
            if state is None and CANCELLED:
                raise InterruptedError("Adapter cancelled")
            if state is None and now >= deadline:
                raise TimeoutError("Adapter timed out")
            remaining = (drain_deadline if drain_deadline is not None else deadline) - now
            for key, _ in streams.select(min(.05, max(0, remaining))):
                chunk = os.read(key.fileobj.fileno(), 4096)
                if not chunk:
                    streams.unregister(key.fileobj)
                    continue
                output[key.data].extend(chunk)
                if sum(map(len, output)) > limit:
                    raise ValueError("Adapter output exceeded byte budget")
        # WNOWAIT reserves the process/group identity until group cleanup.
        while state is None:
            state = os.waitid(os.P_PID, proc.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            if state is not None:
                break
            if CANCELLED:
                raise InterruptedError("Adapter cancelled")
            if time.monotonic() >= deadline:
                raise TimeoutError("Adapter timed out")
            time.sleep(.01)
        code = state.si_status
        if state.si_code != os.CLD_EXITED or code:
            raise ValueError("Helper failed (exit %d): %s" % (code, output[1].decode('utf-8', 'replace')[:512]))
        return output[0].decode('utf-8', 'replace')
    finally:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(proc.pid, signal.SIGKILL)
        proc.wait()
        streams.close()
        proc.stdout.close()
        proc.stderr.close()


def runtime():
    value = os.environ.get('XDG_RUNTIME_DIR', '')
    if not value or not os.path.isabs(value):
        raise ValueError('XDG_RUNTIME_DIR is unavailable')
    info = os.lstat(value)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('Runtime directory must be private and owned by you')
    return os.path.realpath(value)


def private_dir(path):
    base = runtime()
    path = os.path.abspath(path)
    if os.path.dirname(path) != base or not os.path.basename(path).startswith('omacast-'):
        raise ValueError('Request must be directly inside XDG_RUNTIME_DIR')
    info = os.lstat(path)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('Request directory is not private')
    return path


def read_private(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > LIMIT:
            raise ValueError('Invalid private request file')
        data = os.read(fd, LIMIT + 1)
        if len(data) > LIMIT:
            raise ValueError('Request too large')
        return json.loads(data)
    finally:
        os.close(fd)


def picker_request(path):
    folder = private_dir(os.path.dirname(path))
    if os.path.basename(path) != 'request.json':
        raise ValueError('Invalid request filename')
    doc = read_private(path)
    if doc.get('version') != 1 or not isinstance(doc.get('id'), str) or len(doc['id']) != 32:
        raise ValueError('Invalid request identity')
    if not isinstance(doc.get('deadline'), (int, float)) or not time.time() < doc['deadline'] <= time.time() + 301:
        raise ValueError('Picker request expired')
    rows = doc.get('items')
    if not isinstance(rows, list) or len(rows) > 200:
        raise ValueError('Picker accepts at most 200 items')
    seen = set()
    for row in rows:
        if not isinstance(row, dict) or not all(isinstance(row.get(k), str) for k in ('id', 'title', 'value')):
            raise ValueError('Invalid picker row')
        if row['id'] in seen or len(row['value'].encode()) > 8192:
            raise ValueError('Invalid picker row identity or size')
        seen.add(row['id'])
    if not isinstance(doc.get('prompt'), str):
        raise ValueError('Invalid picker prompt')
    return folder, doc


def picker_answer(data):
    folder, doc = picker_request(data['path'])
    if data.get('requestId') != doc['id']:
        raise ValueError('Picker request has changed')
    choice = data.get('selection')
    row = next((r for r in doc['items'] if r['id'] == choice), None)
    if choice is not None and row is None:
        raise ValueError('Selection is not in the current request')
    result = {'id': doc['id'], 'cancelled': row is None, 'value': row['value'] if row else ''}
    # Exclusive creation means no late selection can replace a cancellation.
    fd = os.open(os.path.join(folder, 'response.json'), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(result, stream)
    return {'status': 'ready'}


def agent(data):
    prompt = data.get('prompt', '')
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt.encode()) > 16384:
        raise ValueError('Question must contain 1–16384 bytes')
    default_adapter = not data.get('command')
    command = data.get('command') or ['omp', '--print', '--no-session', '--no-tools', '--no-extensions', '--no-skills', '--no-rules', '--no-lsp', '--no-pty', '--max-time=60', '--approval-mode=always-ask']
    if not isinstance(command, list) or len(command) > 64:
        raise ValueError('Invalid agent command')
    with tempfile.TemporaryDirectory(prefix='omacast-answer-', dir=runtime()) as cwd:
        environment = {key: value for key, value in os.environ.items()
                       if not key.startswith(('PI_', 'OMP_'))}
        if default_adapter:
            # --no-tools does not disable MCP discovery in the installed CLI.
            # No host config roots, stored credentials or imported MCP homes.
            basics = {'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM', 'XDG_RUNTIME_DIR',
                      'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'COPILOT_GITHUB_TOKEN'}
            environment = {key: value for key, value in environment.items()
                           if key in basics or key.endswith(('_API_KEY', '_OAUTH_TOKEN', '_ACCESS_TOKEN', '_BASE_URL'))}
            if not any(value for key, value in environment.items()
                       if key == 'COPILOT_GITHUB_TOKEN' or key.endswith(('_API_KEY', '_OAUTH_TOKEN', '_ACCESS_TOKEN'))):
                raise ValueError('Inline answers require an exported provider API key or an explicit agentCommand; stored account credentials are not loaded')
        for name in ('HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'PI_CONFIG_DIR', 'PI_CODING_AGENT_DIR'):
            directory = os.path.join(cwd, name.lower())
            os.mkdir(directory, 0o700)
            environment[name] = directory
        if default_adapter:
            # OMP expands inline file mentions anywhere in a message, not just
            # at argv start. Joiners preserve visible text without file reads.
            prompt = prompt.replace('@', '\u2060@')
        answer = run(command + ['Question (answer as plain text; do not take actions):\n' + prompt], cwd=cwd, environment=environment)
    return {'status': 'ready' if answer.strip() else 'empty', 'answer': answer}


def semantic(data):
    endpoint = urllib.parse.urlsplit(data.get('endpoint', ''))
    if endpoint.scheme != 'http' or endpoint.hostname not in ('127.0.0.1', '::1') or endpoint.username or endpoint.password or endpoint.path not in ('', '/') or endpoint.query or endpoint.fragment:
        raise ValueError('Semantic endpoint must be an HTTP loopback address')
    model = data.get('model', '')
    if not isinstance(model, str) or not model.strip() or len(model) > 200:
        raise ValueError('Select an installed local embedding model')
    query = data.get('query', '')
    if not isinstance(query, str) or not query.strip() or len(query.encode()) > 2048:
        raise ValueError('Semantic query must contain 1–2048 bytes')
    candidates = data.get('candidates', [])[:32]
    rows, seen = [], set()
    for row in candidates:
        key = row.get('key') or row.get('id')
        if not isinstance(key, str) or not key or key in seen:
            continue
        seen.add(key)
        rows.append({'id': key, 'key': key, 'title': str(row.get('title', ''))[:256], 'subtitle': str(row.get('subtitle', ''))[:256], 'kind': 'semantic'})
    if not rows:
        return {'status': 'empty', 'suggestions': []}
    payload = json.dumps({'model': model, 'input': [query] + [r['title'] + '\n' + r['subtitle'] for r in rows], 'truncate': False}).encode()
    if CANCELLED:
        raise InterruptedError('Embedding request cancelled')
    connection = http.client.HTTPConnection(endpoint.hostname, endpoint.port or 11434, timeout=.25)
    deadline = time.monotonic() + 10
    stop_monitor = threading.Event()
    abort = {'reason': ''}
    transport = None
    monitor = None
    try:
        connection.connect()
        connection.sock.settimeout(10)
        # Keep a duplicate even if HTTPConnection transfers socket ownership
        # to a Connection: close response before body collection finishes.
        transport = socket.socket(fileno=os.dup(connection.sock.fileno()))
        def watch_transport():
            while not stop_monitor.wait(.02):
                if CANCELLED or time.monotonic() >= deadline:
                    abort['reason'] = 'cancelled' if CANCELLED else 'timeout'
                    with contextlib.suppress(OSError):
                        transport.shutdown(socket.SHUT_RDWR)
                    return
        monitor = threading.Thread(target=watch_transport, daemon=True)
        monitor.start()
        connection.request('POST', '/api/embed', body=payload, headers={'Content-Type': 'application/json'})
        response = connection.getresponse()
        chunks = bytearray()
        while True:
            if time.monotonic() > deadline:
                raise TimeoutError('Embedding request timed out')
            chunk = response.read1(8192)
            if CANCELLED:
                raise InterruptedError('Embedding request cancelled')
            if not chunk:
                break
            chunks.extend(chunk)
            if len(chunks) > 2 * 1024 * 1024:
                raise ValueError('Embedding response exceeded byte budget')
        if CANCELLED or abort['reason'] == 'cancelled':
            raise InterruptedError('Embedding request cancelled')
        if abort['reason'] == 'timeout':
            raise TimeoutError('Embedding request timed out')
        if response.status != 200:
            raise ValueError('Local embedding API failed (HTTP %d); check service and installed model' % response.status)
        vectors = json.loads(chunks).get('embeddings')
        if not isinstance(vectors, list) or len(vectors) != len(rows) + 1:
            raise ValueError('Embedding API returned an invalid vector count')
        dimension = len(vectors[0]) if isinstance(vectors[0], list) else 0
        if not 1 <= dimension <= 8192:
            raise ValueError('Invalid embedding dimension')
        for vector in vectors:
            if not isinstance(vector, list) or len(vector) != dimension or any(type(v) not in (float, int) or not math.isfinite(v) for v in vector):
                raise ValueError('Invalid embedding vector')
        norms = [math.sqrt(sum(v * v for v in vector)) for vector in vectors]
        if any(not math.isfinite(n) or n == 0 for n in norms):
            raise ValueError('Embedding vectors must have finite nonzero norms')
        for index, row in enumerate(rows):
            row['score'] = sum(a * b for a, b in zip(vectors[0], vectors[index + 1])) / (norms[0] * norms[index + 1])
        rows.sort(key=lambda row: -row['score'])
        return {'status': 'ready', 'suggestions': rows[:8]}
    except InterruptedError:
        raise
    except TimeoutError:
        if CANCELLED:
            raise InterruptedError('Embedding request cancelled')
        raise
    except OSError as error:
        if CANCELLED or abort['reason'] == 'cancelled':
            raise InterruptedError('Embedding request cancelled')
        if abort['reason'] == 'timeout':
            raise TimeoutError('Embedding request timed out')
        raise ValueError('Local embedding service unavailable: ' + str(error))
    finally:
        stop_monitor.set()
        if monitor is not None:
            monitor.join()
        if transport is not None:
            transport.close()
        connection.close()


def dispatch(mode, data):
    if mode == 'agent': return agent(data)
    if mode == 'semantic': return semantic(data)
    if mode == 'picker-read':
        _, doc = picker_request(data['path'])
        return {'status': 'ready', **doc}
    if mode == 'picker-answer': return picker_answer(data)
    raise ValueError('Unknown adapter')


def lifetime_owner():
    # A separate controller owns the write end. Even SIGKILL of that
    # controller closes the pipe and asks its owner child to clean up.
    read_fd, write_fd = os.pipe()
    owner = os.fork()
    if owner:
        os.close(read_fd)
        def release(signum, frame):
            nonlocal write_fd
            if write_fd >= 0:
                os.close(write_fd)
                write_fd = -1
        signal.signal(signal.SIGTERM, release)
        signal.signal(signal.SIGINT, release)
        try:
            while True:
                try:
                    _, status = os.waitpid(owner, 0)
                    break
                except InterruptedError:
                    continue
        finally:
            if write_fd >= 0:
                os.close(write_fd)
        os._exit(os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) else 130)
    os.close(write_fd)
    signal.signal(signal.SIGTERM, cancel_signal)
    signal.signal(signal.SIGINT, cancel_signal)
    def monitor():
        try:
            os.read(read_fd, 1)
            os.kill(os.getpid(), signal.SIGTERM)
        finally:
            os.close(read_fd)
    threading.Thread(target=monitor, daemon=True).start()


if __name__ == '__main__':
    lifetime_owner()
    signal.signal(signal.SIGTERM, cancel_signal)
    signal.signal(signal.SIGINT, cancel_signal)
    try:
        result = dispatch(sys.argv[1], json.loads(sys.argv[2]))
    except InterruptedError as error:
        result = {'status': 'cancelled', 'error': str(error)}
    except TimeoutError as error:
        result = {'status': 'timeout', 'error': str(error)}
    except Exception as error:
        result = {'status': 'failed', 'error': str(error)}
    print(json.dumps(result, ensure_ascii=True), flush=True)

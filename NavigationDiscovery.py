"""Bounded, opt-in local navigation discovery. No shell evaluation."""
import glob
import json
import os
import resource
import shlex
import stat
import subprocess
import sys
import tempfile

LIMIT = 262144
MAX_FILES = 32
errors = []
remaining = 1048576


def path(value, home):
    if not isinstance(value, str) or not value or '\x00' in value:
        raise ValueError('Expected a local path')
    if value == '~' or value.startswith('~/'):
        value = home + value[1:]
    if not os.path.isabs(value):
        raise ValueError('Expected an absolute local path: ' + value)
    return os.path.normpath(value)


def read_file(filename, limit=LIMIT):
    global remaining
    with open(filename, 'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError('Not a regular file: ' + filename)
        raw = stream.read(min(limit, remaining) + 1)
    if len(raw) > limit or len(raw) > remaining:
        raise ValueError('File budget exceeded: ' + filename)
    remaining -= len(raw)
    return raw.decode('utf-8')


def command(argv):
    # Regular-file output and RLIMIT_FSIZE cap both streams before collection.
    def limits():
        resource.setrlimit(resource.RLIMIT_FSIZE, (LIMIT, LIMIT))
    with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as error:
        result = subprocess.run(argv, stdout=output, stderr=error, timeout=3,
                                preexec_fn=limits, check=False)
        output.seek(0)
        data = output.read(LIMIT + 1)
        if result.returncode or len(data) >= LIMIT:
            raise ValueError('Command failed or exceeded output budget: ' + argv[0])
        return data.decode('utf-8')


def discover(mode, config, home):
    if mode == 'projects':
        records = []
        for root in config.get('projectRoots', [])[:MAX_FILES]:
            try:
                target = path(root.get('path') if isinstance(root, dict) else root, home)
                with os.scandir(target) as entries:
                    count = 0
                    for entry in entries:
                        count += 1
                        if count > 2000:
                            errors.append('Directory entry budget exceeded: ' + target)
                            break
                        if not entry.name.startswith('.') and entry.is_dir(follow_symlinks=False):
                            records.append({'path': entry.path})
                        if len(records) >= 1000:
                            errors.append('Project result budget exceeded')
                            return records
            except (OSError, ValueError) as error:
                errors.append(str(error))
        return records
    if mode == 'zoxide':
        records = []
        for value in command(['zoxide', 'query', '--list']).splitlines()[:1000]:
            target = path(value, home)
            if os.path.isdir(target):
                records.append({'path': target})
            else:
                errors.append('Stale project: ' + target)
        return records
    if mode == 'plugins':
        return command([config.get('pluginCli', 'omarchy'), 'plugin', 'list', '--json'])
    if mode == 'bookmarks':
        records = []
        for value in config.get('bookmarkFiles', [])[:MAX_FILES]:
            try:
                target = path(value.get('path') if isinstance(value, dict) else value, home)
                records.append({'path': target, 'text': read_file(target, 1048576)})
            except (OSError, ValueError, UnicodeError) as error:
                errors.append(str(error))
        return records
    if mode == 'ssh':
        records, seen = [], set()
        def visit(filename, depth):
            if depth > 4 or len(seen) >= MAX_FILES:
                errors.append('SSH Include depth/file budget exceeded')
                return
            filename = os.path.realpath(filename)
            if filename in seen:
                return
            seen.add(filename)
            try:
                text = read_file(filename)
                records.append({'path': filename, 'text': text})
                for line in text.splitlines():
                    lexer = shlex.shlex(line, posix=True)
                    lexer.whitespace_split = True
                    lexer.commenters = '#'
                    lexer.wordchars += '='
                    try:
                        tokens = list(lexer)
                    except ValueError:
                        errors.append('Malformed SSH config line: ' + filename)
                        continue
                    if not tokens:
                        continue
                    if tokens[0].lower().startswith('include='):
                        tokens = ['Include', tokens[0][8:]] + tokens[1:]
                    if tokens[0].lower() != 'include':
                        continue
                    for pattern in tokens[1:]:
                        if pattern == '=':
                            continue
                        if '%' in pattern or '$' in pattern or '\x00' in pattern:
                            errors.append('Unsupported SSH Include expansion: ' + pattern)
                            continue
                        if pattern.startswith('~/'):
                            pattern = home + pattern[1:]
                        elif not os.path.isabs(pattern):
                            pattern = os.path.join(home, '.ssh', pattern)
                        matched = False
                        # iglob avoids materializing an unbounded match list.
                        for index, included in enumerate(glob.iglob(pattern)):
                            if index >= MAX_FILES:
                                errors.append('SSH Include match budget exceeded')
                                break
                            matched = True
                            visit(included, depth + 1)
                        if not matched:
                            errors.append('SSH Include not found: ' + pattern)
            except (OSError, ValueError, UnicodeError) as error:
                errors.append(str(error))
        for value in (config.get('sshConfigFiles') or [home + '/.ssh/config'])[:MAX_FILES]:
            try:
                visit(path(value, home), 0)
            except ValueError as error:
                errors.append(str(error))
        return records
    raise ValueError('Unknown navigation source')


if __name__ == '__main__':
    try:
        result = discover(sys.argv[1], json.loads(sys.argv[2]), sys.argv[3])
        print(json.dumps({'data': result, 'errors': errors[:20]}, ensure_ascii=True))
    except subprocess.TimeoutExpired as error:
        print(json.dumps({'data': [], 'errors': [str(error)], 'timeout': True}))
        sys.exit(124)
    except (OSError, ValueError, UnicodeError) as error:
        print(json.dumps({'data': [], 'errors': [str(error)]}))
        sys.exit(1)

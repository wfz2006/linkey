# -*- coding: utf-8 -*-
import sys, io, re, os
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

pattern = sys.argv[1]
files = sys.argv[2:]
rx = re.compile(pattern)
for f in files:
    try:
        with open(f, encoding='utf-8', errors='replace') as fh:
            for n, line in enumerate(fh, 1):
                if rx.search(line):
                    print(f'{os.path.basename(f)}:{n}: {line.rstrip()[:180]}')
    except OSError as e:
        print(f'{f}: ERR {e}')

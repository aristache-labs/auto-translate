import re

file_path = 'app.js'

with open(file_path, 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Find async methods
for i, line in enumerate(lines, 1):
    if re.match(r'\s*async _start', line):
        print(f"Line {i}: {line.rstrip()}")

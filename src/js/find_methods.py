import re

file_path = 'app.js'

# Read the file
with open(file_path, 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Find key method locations
for i, line in enumerate(lines, 1):
    if 'async stop()' in line or 'async _startOpenAiMode' in line or 'async _startQwenMode' in line or 'async _startSonioxMode' in line or '} else if (this.translationMode === ' in line:
        print(f"Line {i}: {line.rstrip()}")
        if i < len(lines):
            print(f"Line {i+1}: {lines[i].rstrip()}")

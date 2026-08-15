import re

file_path = 'app.js'

with open(file_path, 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Find _startLocalMode and print it
in_method = False
method_lines = []
brace_count = 0

for i, line in enumerate(lines, 1):
    if 'async _startLocalMode(settings)' in line:
        in_method = True
    
    if in_method:
        method_lines.append(f"{i}: {line.rstrip()}")
        brace_count += line.count('{') - line.count('}')
        
        if brace_count == 0 and len(method_lines) > 1:
            break

# Print first 100 lines
for line in method_lines[:100]:
    print(line)

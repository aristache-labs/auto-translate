import re

file_path = 'app.js'

# Read the file
with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Remove soniox and qwen-langs imports
content = re.sub(r"import \{ sonioxClient \} from './soniox\.js';\s*\n", "", content)
content = re.sub(r"import \{ QWEN_LANGS \} from './qwen-langs\.js';\s*\n", "", content)

# 2. Add new imports after sessionStore import
import_pattern = r"(import \{ sessionStore \} from './session-store\.js';)"
new_imports = r"\1\nimport { groqClient } from './groq-client.js';\nimport { cloudflareClient } from './cloudflare-client.js';"
content = re.sub(import_pattern, new_imports, content)

# 3. Update constructor default
content = re.sub(
    r"this\.translationMode = 'soniox';",
    "this.translationMode = 'groq';",
    content
)

# 4. Update sessionStore.init() default
content = re.sub(
    r"engine: initSettings\.translation_mode \|\| 'soniox',",
    "engine: initSettings.translation_mode || 'groq',",
    content
)

# Write the file back
with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print("Step 1-4 complete: Imports and defaults updated")

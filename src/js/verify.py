file_path = 'app.js'

with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Check for any remaining old references
checks = [
    ('sonioxClient', "import { sonioxClient }"),
    ('QWEN_LANGS', "import { QWEN_LANGS }"),
    ('_startOpenAiMode', "async _startOpenAiMode"),
    ('_startQwenMode', "async _startQwenMode"),
    ('_startSonioxMode', "async _startSonioxMode"),
]

print("=== Checking for old references ===")
for name, pattern in checks:
    if pattern in content:
        print(f"❌ Found: {name}")
    else:
        print(f"✓ Removed: {name}")

# Check for new references
new_checks = [
    ('groqClient import', "import { groqClient }"),
    ('cloudflareClient import', "import { cloudflareClient }"),
    ('_startGroqMode', "async _startGroqMode"),
    ('_startCloudflareMode', "async _startCloudflareMode"),
    ('_transitionToCloudflare', "async _transitionToCloudflare"),
]

print("\n=== Checking for new references ===")
for name, pattern in new_checks:
    if pattern in content:
        print(f"✓ Found: {name}")
    else:
        print(f"❌ Missing: {name}")

# Check mode routing
print("\n=== Checking mode routing in start() ===")
if "'groq'" in content and "'cloudflare'" in content:
    print("✓ Both 'groq' and 'cloudflare' modes present")
else:
    print("❌ Mode routing incomplete")

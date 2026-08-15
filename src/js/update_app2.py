import re

file_path = 'app.js'

# Read the file
with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# 5. Update start() method key checks
# Replace Soniox check with Groq check
content = re.sub(
    r"if \(this\.translationMode === 'soniox' && !settings\.soniox_api_key\)",
    "if (this.translationMode === 'groq' && !settings.groq_api_key)",
    content
)

# Replace OpenAI check with Cloudflare check
content = re.sub(
    r"if \(this\.translationMode === 'openai' && !settings\.openai_api_key\)",
    "if (this.translationMode === 'cloudflare' && (!settings.cloudflare_account_id || !settings.cloudflare_api_token))",
    content
)

# Remove Qwen check
content = re.sub(
    r"\s*if \(this\.translationMode === 'qwen' && !settings\.qwen_api_key\).*?\n.*?this\._showView\('settings'\);\s*\n\s*\}",
    "",
    content,
    flags=re.DOTALL
)

# 6. Update mode routing in start() method
# Replace the mode routing block
old_routing = r"""if \(this\.translationMode === 'local'\) \{
\s*await this\._startLocalMode\(settings\);
\s*\} else if \(this\.translationMode === 'openai'\) \{
\s*await this\._startOpenAiMode\(settings\);
\s*\} else if \(this\.translationMode === 'qwen'\) \{
\s*await this\._startQwenMode\(settings\);
\s*\} else \{
\s*await this\._startSonioxMode\(settings\);
\s*\}"""

new_routing = """if (this.translationMode === 'local') {
            await this._startLocalMode(settings);
        } else if (this.translationMode === 'groq') {
            await this._startGroqMode(settings);
        } else if (this.translationMode === 'cloudflare') {
            await this._startCloudflareMode(settings);
        }"""

content = re.sub(old_routing, new_routing, content, flags=re.DOTALL)

# Write the file back
with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print("Step 5-6 complete: start() method key checks and routing updated")

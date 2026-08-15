import re

file_path = 'app.js'

# Read the file
with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# 7. Remove old mode methods: _startOpenAiMode, _startQwenMode, _startSonioxMode
# This is complex because we need to find and remove entire method bodies

# Remove _startOpenAiMode (from method declaration to next method)
content = re.sub(
    r"\s*async _startOpenAiMode\(settings\).*?(?=\s*async _startQwenMode|\s*async _startQwenMode|\s*async _startLocalMode|\s*async)",
    "",
    content,
    flags=re.DOTALL
)

# Remove _startQwenMode
content = re.sub(
    r"\s*async _startQwenMode\(settings\).*?(?=\s*async _startSonioxMode|\s*async _startLocalMode|\s*async)",
    "",
    content,
    flags=re.DOTALL
)

# Remove _startSonioxMode
content = re.sub(
    r"\s*async _startSonioxMode\(settings\).*?(?=\s*async _startLocalMode|\s*async)",
    "",
    content,
    flags=re.DOTALL
)

# 8. Update stop() method - replace mode checks from openai/qwen to groq/cloudflare
content = re.sub(
    r"} else if \(this\.translationMode === 'openai'\).*?this\._updateStatus\('disconnected'\);",
    """} else if (this.translationMode === 'groq') {
            if (this.groqClient) {
                try { await this.groqClient.disconnect(); } catch {}
            }
            this._updateStatus('disconnected');
        } else if (this.translationMode === 'cloudflare') {
            if (this.cloudflareClient) {
                try { await this.cloudflareClient.disconnect(); } catch {}
            }
            this._updateStatus('disconnected');""",
    content,
    flags=re.DOTALL
)

# Remove the qwen disconnect section
content = re.sub(
    r"\s*} else if \(this\.translationMode === 'qwen'\).*?this\._updateStatus\('disconnected'\);",
    "",
    content,
    flags=re.DOTALL
)

# Write the file back
with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print("Step 7-8 complete: Old methods removed and stop() updated")

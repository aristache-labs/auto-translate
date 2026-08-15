import re

file_path = 'app.js'

# Read the file
with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Update the model name references in session metadata
# Replace Soniox model name
content = re.sub(
    r"model: this\.translationMode === 'soniox' \? 'Soniox Cloud API' : 'Local MLX Whisper',",
    "model: this.translationMode === 'local' ? 'Local MLX Whisper' : this.translationMode.charAt(0).toUpperCase() + this.translationMode.slice(1) + ' API',",
    content
)

# Update stop() to use groqClient and cloudflareClient instead of openAiClient, qwenClient, sonioxClient
# First handle groq mode (replacing openai reference if it exists)
content = re.sub(
    r"if \(this\.translationMode === 'local'\).*?this\.localPipelineChannel = null;",
    """if (this.translationMode === 'local') {
            // Stop local pipeline
            try {
                const { invoke } = window.__TAURI__.core;
                await invoke('stop_capture');
                await invoke('stop_local_pipeline');
            } catch (err) {
                console.warn('[App] Error stopping local pipeline:', err);
            }
            this.transcriptUI.removeStatusMessage();
            this._updateStatus('disconnected');
            this.localPipelineChannel = null;""",
    content,
    flags=re.DOTALL
)

# Add or update groq and cloudflare stops
stop_method = re.search(r'async stop\(\)\s*\{.*?(?=\s*async pause)', content, re.DOTALL)
if stop_method:
    # Check if it already has the groq/cloudflare stops, if not add them
    if 'this.groqClient' not in content[stop_method.start():stop_method.end()]:
        # Find the end of the local mode stop handling
        local_stop_end = content.find("this.localPipelineChannel = null;", stop_method.start())
        if local_stop_end > 0:
            local_stop_end = content.find('\n', local_stop_end) + 1
            groq_cf_stop = """        } else if (this.translationMode === 'groq') {
            if (this.groqClient) {
                try { await this.groqClient.disconnect(); } catch {}
            }
            this._updateStatus('disconnected');
        } else if (this.translationMode === 'cloudflare') {
            if (this.cloudflareClient) {
                try { await this.cloudflareClient.disconnect(); } catch {}
            }
            this._updateStatus('disconnected');
"""
            content = content[:local_stop_end] + groq_cf_stop + content[local_stop_end:]

# Write the file back
with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print("Step 10 complete: Updated stop() method and model references")

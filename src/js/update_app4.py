import re

file_path = 'app.js'

# Read the file
with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Create the _startGroqMode method
groq_method = '''    async _startGroqMode(settings) {
        this._updateStatus('connecting');
        console.log('[App] Starting Groq mode...');
        this.transcriptUI.provider = 'groq';
        
        this.groqClient = new (await import('./groq-client.js')).GroqClient();
        
        // Set up callbacks
        this.groqClient.onStatusChange = (status) => {
            console.log('[App] Groq status:', status);
            this._updateStatus(status);
        };
        
        this.groqClient.onProvisional = (text, speaker, language) => {
            this.transcriptUI.addProvisional(text);
        };
        
        this.groqClient.onOriginal = (text, speaker, language) => {
            this.transcriptUI.setOriginal(text);
        };
        
        this.groqClient.onTranslation = (text) => {
            this.transcriptUI.setTranslation(text);
        };
        
        this.groqClient.onSegment = (sourceText, translatedText) => {
            this.transcriptUI.addSegment(sourceText, translatedText);
        };
        
        this.groqClient.onError = (error) => {
            console.error('[App] Groq error:', error);
            this._showToast(`Groq error: ${error}`, 'error');
            this._transitionToCloudflare();
        };
        
        this.groqClient.onFallback = (reason) => {
            console.log('[App] Groq fallback:', reason);
            this._showToast(`Switching to Cloudflare: ${reason}`, 'info');
            this._transitionToCloudflare();
        };
        
        try {
            // Connect to Groq
            this.groqClient.connect({
                apiKey: settings.groq_api_key,
                sourceLang: settings.source_language || 'auto',
                targetLang: settings.target_language || 'vi',
            });
            
            // Start audio capture
            const audioChannel = new window.__TAURI__.core.Channel();
            let audioChunkCount = 0;
            
            audioChannel.onmessage = async (pcmData) => {
                audioChunkCount++;
                if (audioChunkCount <= 3 || audioChunkCount % 100 === 0) {
                    console.log(`[Groq] Audio batch #${audioChunkCount}, size:`, pcmData?.length || 0);
                }
                try {
                    await this.groqClient.sendAudio(pcmData);
                } catch (e) {
                    console.warn('[Groq] Send audio error:', e);
                }
            };
            
            const { invoke } = window.__TAURI__.core;
            await invoke('start_capture', {
                source: this.currentSource,
                channel: audioChannel,
            });
            
            this.isRunning = true;
            this._updateStartButton();
            this.recordingStartTime = Date.now();
            if (!this.sessionStartTime) {
                this.sessionStartTime = new Date();
            }
            this.sessionSourceLang = settings.source_language || 'auto';
            this.sessionTargetLang = settings.target_language || 'vi';
        } catch (err) {
            console.error('[App] Failed to start Groq mode:', err);
            this._showToast(`Groq connection failed: ${err}`, 'error');
            this.isRunning = false;
            this._updateStartButton();
            this._updateStatus('error');
            this.transcriptUI.clear();
            this.transcriptUI.showPlaceholder();
        }
    }

    async _startCloudflareMode(settings) {
        this._updateStatus('connecting');
        console.log('[App] Starting Cloudflare mode...');
        this.transcriptUI.provider = 'cloudflare';
        
        this.cloudflareClient = new (await import('./cloudflare-client.js')).CloudflareClient();
        
        // Set up callbacks
        this.cloudflareClient.onStatusChange = (status) => {
            console.log('[App] Cloudflare status:', status);
            this._updateStatus(status);
        };
        
        this.cloudflareClient.onProvisional = (text, speaker, language) => {
            this.transcriptUI.addProvisional(text);
        };
        
        this.cloudflareClient.onOriginal = (text, speaker, language) => {
            this.transcriptUI.setOriginal(text);
        };
        
        this.cloudflareClient.onTranslation = (text) => {
            this.transcriptUI.setTranslation(text);
        };
        
        this.cloudflareClient.onSegment = (sourceText, translatedText) => {
            this.transcriptUI.addSegment(sourceText, translatedText);
        };
        
        this.cloudflareClient.onError = (error) => {
            console.error('[App] Cloudflare error:', error);
            this._showToast(`Cloudflare error: ${error}`, 'error');
        };
        
        try {
            // Connect to Cloudflare
            this.cloudflareClient.connect({
                accountId: settings.cloudflare_account_id,
                apiToken: settings.cloudflare_api_token,
                sourceLang: settings.source_language || 'auto',
                targetLang: settings.target_language || 'vi',
            });
            
            // Start audio capture
            const audioChannel = new window.__TAURI__.core.Channel();
            let audioChunkCount = 0;
            
            audioChannel.onmessage = async (pcmData) => {
                audioChunkCount++;
                if (audioChunkCount <= 3 || audioChunkCount % 100 === 0) {
                    console.log(`[Cloudflare] Audio batch #${audioChunkCount}, size:`, pcmData?.length || 0);
                }
                try {
                    await this.cloudflareClient.sendAudio(pcmData);
                } catch (e) {
                    console.warn('[Cloudflare] Send audio error:', e);
                }
            };
            
            const { invoke } = window.__TAURI__.core;
            await invoke('start_capture', {
                source: this.currentSource,
                channel: audioChannel,
            });
            
            this.isRunning = true;
            this._updateStartButton();
            this.recordingStartTime = Date.now();
            if (!this.sessionStartTime) {
                this.sessionStartTime = new Date();
            }
            this.sessionSourceLang = settings.source_language || 'auto';
            this.sessionTargetLang = settings.target_language || 'vi';
        } catch (err) {
            console.error('[App] Failed to start Cloudflare mode:', err);
            this._showToast(`Cloudflare connection failed: ${err}`, 'error');
            this.isRunning = false;
            this._updateStartButton();
            this._updateStatus('error');
            this.transcriptUI.clear();
            this.transcriptUI.showPlaceholder();
        }
    }

    async _transitionToCloudflare() {
        console.log('[App] Transitioning to Cloudflare from Groq...');
        try {
            // Disconnect Groq
            if (this.groqClient) {
                try { await this.groqClient.disconnect(); } catch {}
                this.groqClient = null;
            }
            
            // Stop current audio capture
            try {
                const { invoke } = window.__TAURI__.core;
                await invoke('stop_capture');
            } catch {}
            
            // Start Cloudflare mode
            const settings = settingsManager.get();
            this.translationMode = 'cloudflare';
            await this._startCloudflareMode(settings);
        } catch (err) {
            console.error('[App] Transition to Cloudflare failed:', err);
            this._showToast(`Fallback to Cloudflare failed: ${err}`, 'error');
            await this.pause();
        }
    }

'''

# Find where to insert - right before _startLocalMode
insert_pos = content.find('    async _startLocalMode(settings) {')
if insert_pos > 0:
    # Insert the new methods
    content = content[:insert_pos] + groq_method + content[insert_pos:]

# Write the file back
with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print("Step 9 complete: Created _startGroqMode, _startCloudflareMode, and _transitionToCloudflare methods")

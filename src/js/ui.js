import {
    commonPrefixLength,
    nextRevealCount,
    textLength,
    visibleText,
} from './adaptive-typewriter.js';

const MERGE_MAX_CHARS = 760;
const MERGE_MAX_GAP_MS = 12000;

function comparableToken(token) {
    return normalizedSpeech(token);
}

function overlappingWordCount(previousWords, nextWords) {
    const maxOverlap = Math.min(12, previousWords.length, nextWords.length);
    for (let size = maxOverlap; size > 0; size -= 1) {
        const previousTail = previousWords.slice(-size).map(comparableToken);
        const nextHead = nextWords.slice(0, size).map(comparableToken);
        if (previousTail.some((token) => !token) || nextHead.some((token) => !token)) continue;
        if (!previousTail.every((token, index) => token === nextHead[index])) continue;

        // A single common short word is weak evidence of an STT overlap. Longer
        // words ("episode", "literally") and multi-word matches are safe to fold.
        if (size > 1 || previousTail[0].length >= 5) return size;
    }
    return 0;
}

function joinSpeech(prev, next) {
    const a = (prev || '').trim();
    const b = (next || '').trim();
    if (!a) return b;
    if (!b) return a;
    const previousWords = a.split(/\s+/);
    const nextWords = b.split(/\s+/);
    const overlap = overlappingWordCount(previousWords, nextWords);
    return `${a} ${nextWords.slice(overlap).join(' ')}`.replace(/\s+/g, ' ').trim();
}

function normalizedSpeech(text) {
    return (text || '')
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

function repeatsRecentTail(recentText, candidate) {
    const recent = normalizedSpeech(recentText);
    const next = normalizedSpeech(candidate);
    if (!recent || !next) return false;
    const meaningfulSingleWord = !next.includes(' ') && next.length >= 5;
    return recent === next
        || ((next.length >= 12 || meaningfulSingleWord) && recent.endsWith(next));
}

function liveRemainder(committed, draft) {
    const a = (committed || '').trim();
    const b = (draft || '').trim();
    if (!b) return '';
    if (!a) return b;
    if (repeatsRecentTail(a, b)) return '';
    const lowerA = a.toLocaleLowerCase();
    const lowerB = b.toLocaleLowerCase();
    if (lowerB.startsWith(lowerA)) {
        return b.slice(a.length).replace(/^\s+/, '');
    }
    const overlap = overlappingWordCount(a.split(/\s+/), b.split(/\s+/));
    if (overlap > 0) return b.split(/\s+/).slice(overlap).join(' ');
    return b;
}

function languageCode(code) {
    return String(code || '').trim().toLowerCase().split(/[-_]/)[0];
}

function sameConversationLanguage(a, b) {
    if (!a || !b) return true;
    const left = languageCode(a);
    const right = languageCode(b);
    if (!left || !right || left === 'auto' || right === 'auto') return true;
    return left === right;
}

/**
 * Transcript UI — paired live interpretation with speaker diarization.
 *
 * Each finalized source segment and its translation share one visual row, so
 * different line wrapping can never cause the two languages to drift apart.
 * Provisional and finalized text use the same bounded typewriter treatment.
 */

export class TranscriptUI {
    constructor(container) {
        this.container = container;
        this.contentEl = null;
        this.maxChars = 1200;
        this.fontSize = 16;
        this.viewMode = 'single'; // 'single' or 'dual'
        this.sourceLanguage = 'auto';
        this.targetLanguage = 'vi';

        // Segments: each has { original, translation, status, speaker, language, confidence }
        this.segments = [];
        // sessionLog: parallel array — never trimmed, holds complete session history
        this.sessionLog = [];
        this.provisionalText = '';
        this.provisionalSpeaker = null;
        this.provisionalLanguage = null;
        // Source-side provisional (OpenAI Realtime: source ASR is separate from target).
        // Soniox leaves this empty; its provisionalText carries the source-language ASR.
        this.sourceProvisionalText = '';
        this.provisionalVisible = 0;
        this.sourceProvisionalVisible = 0;
        this.translationProvisionalText = '';
        this.translationProvisionalVisible = 0;
        this._provisionalStartedAt = 0;
        this._sourceProvisionalStartedAt = 0;
        this._translationProvisionalStartedAt = 0;
        this._animationFrame = null;
        this._animationLastAt = 0;
        this._tickTypewriter = this._tickTypewriter.bind(this);
        this._motionPreference = typeof window !== 'undefined'
            && typeof window.matchMedia === 'function'
            ? window.matchMedia('(prefers-reduced-motion: reduce)')
            : null;
        this._reducedMotion = Boolean(this._motionPreference?.matches);
        this._motionPreference?.addEventListener?.('change', (event) => {
            this._reducedMotion = event.matches;
            if (event.matches) {
                this._stopTypewriter();
                if (this._revealAllText()) this._render();
            }
        });
        // Provider hint — Soniox puts source-language in provisionalText; OpenAI
        // splits source/target streams; Qwen Live Flash emits target-only.
        // Backing field for the `provider` getter/setter below.
        this._provider = 'soniox';
        this.currentSpeaker = null; // Track current speaker to detect changes
        this.currentLanguage = null; // Track current language to detect changes
        this.lastConfidence = null; // Last confidence score from Soniox
    }

    get provider() {
        return this._provider;
    }

    set provider(value) {
        this._provider = value;
        // Qwen Live Flash has no source channel — strip the dual-view CSS class
        // so the overlay reverts to single-column layout even if viewMode='dual'.
        const overlay = document.getElementById('overlay-view');
        if (overlay) {
            const wantsDual = this.viewMode === 'dual' && value !== 'qwen';
            overlay.classList.toggle('dual-view', wantsDual);
        }
    }

    /**
     * Update display settings
     */
    configure({
        maxLines,
        showOriginal,
        fontSize,
        fontColor,
        viewMode,
        sourceLanguage,
        targetLanguage,
    }) {
        let shouldRender = false;
        if (maxLines !== undefined) this.maxChars = maxLines * 160;
        if (sourceLanguage !== undefined) {
            this.sourceLanguage = sourceLanguage || 'auto';
            shouldRender = true;
        }
        if (targetLanguage !== undefined) {
            this.targetLanguage = targetLanguage || 'vi';
            shouldRender = true;
        }
        if (fontSize !== undefined) {
            this.fontSize = fontSize;
            this.container.style.setProperty('--transcript-font-size', `${fontSize}px`);
        }
        if (fontColor !== undefined) {
            this.fontColor = fontColor;
            this.container.style.setProperty('--transcript-font-color', fontColor);
        }
        if (viewMode !== undefined) {
            this.viewMode = viewMode;
            const overlay = document.getElementById('overlay-view');
            if (overlay) {
                const wantsDual = viewMode === 'dual' && this._provider !== 'qwen';
                overlay.classList.toggle('dual-view', wantsDual);
            }
            this._render();
            shouldRender = false;
        }
        if (shouldRender && this.contentEl) this._render();
    }

    /**
     * Add finalized original text (pending translation)
     */
    addOriginal(text, speaker, language) {
        this._removeListening();
        const chunk = (text || '').trim();
        if (!chunk) return;

        const last = this.segments[this.segments.length - 1];
        if (last && this._canMergeOriginal(last, chunk, speaker, language)) {
            const previousTotal = textLength(last.original);
            const wasCaughtUp = (last.originalVisible ?? previousTotal) >= previousTotal;
            const now = Date.now();
            last.original = joinSpeech(last.original, chunk);
            last.pendingTranslations = (last.pendingTranslations ?? 0) + 1;
            last.updatedAt = now;
            if (this._reducedMotion) {
                last.originalVisible = textLength(last.original);
            } else if (wasCaughtUp) {
                last.originalVisible = previousTotal;
                last.originalAnimationStartedAt = now;
            }
            if (speaker) last.speaker = speaker;
            if (language) last.language = language;
            const logSeg = this.sessionLog.find((s) => s.createdAt === last.createdAt)
                || this.sessionLog[this.sessionLog.length - 1];
            if (logSeg) {
                logSeg.original = last.original;
                logSeg.speaker = last.speaker;
                logSeg.language = last.language;
            }
            if (speaker) this.currentSpeaker = speaker;
            if (language) this.currentLanguage = language;
            this._render();
            this._queueTypewriter();
            return;
        }

        const createdAt = Date.now();
        const seg = {
            original: chunk,
            translation: null,
            status: 'original',
            speaker: speaker || null,
            language: language || null,
            confidence: this.lastConfidence,
            createdAt,
            updatedAt: createdAt,
            pendingTranslations: 1,
            originalVisible: this._reducedMotion ? textLength(chunk) : 0,
            translationVisible: 0,
            originalAnimationStartedAt: createdAt,
            translationAnimationStartedAt: 0,
        };
        this.segments.push(seg);
        this.sessionLog.push({
            original: chunk,
            translation: null,
            status: 'original',
            speaker: speaker || null,
            language: language || null,
            confidence: this.lastConfidence,
            createdAt: seg.createdAt,
        });
        if (speaker) this.currentSpeaker = speaker;
        if (language) this.currentLanguage = language;
        this._cleanupStaleOriginals();
        this._render();
        this._queueTypewriter();
    }

    /**
     * Apply translation to the oldest untranslated segment
     */
    addTranslation(text) {
        const chunk = (text || '').trim();
        if (!chunk) return;
        const seg = this.segments.find((s) => (s.pendingTranslations || 0) > 0)
            || this.segments.find((s) => s.status === 'original');
        if (seg) {
            seg.translation = seg.translation
                ? joinSpeech(seg.translation, chunk)
                : chunk;
            seg.status = 'translated';
            seg.pendingTranslations = Math.max(0, (seg.pendingTranslations || 1) - 1);
            seg.updatedAt = Date.now();
            if (!seg.translationAnimationStartedAt) {
                seg.translationVisible = this._reducedMotion ? textLength(seg.translation) : 0;
            }
            seg.translationAnimationStartedAt = Date.now();
            const logSeg = this.sessionLog.find((s) => s.createdAt === seg.createdAt);
            if (logSeg) {
                logSeg.translation = seg.translation;
                logSeg.status = 'translated';
            }
        } else {
            const createdAt = Date.now();
            const last = this.segments[this.segments.length - 1];
            if (this._canMergeTranslationOnly(last, chunk)) {
                const previousTotal = textLength(last.translation);
                const wasCaughtUp = (last.translationVisible ?? previousTotal) >= previousTotal;
                last.translation = joinSpeech(last.translation, chunk);
                last.updatedAt = createdAt;
                if (this._reducedMotion) {
                    last.translationVisible = textLength(last.translation);
                } else if (wasCaughtUp) {
                    last.translationVisible = previousTotal;
                    last.translationAnimationStartedAt = createdAt;
                }
                const logSeg = this.sessionLog.find((s) => s.createdAt === last.createdAt);
                if (logSeg) logSeg.translation = last.translation;
            } else {
                const newSeg = {
                    original: '',
                    translation: chunk,
                    status: 'translated',
                    speaker: null,
                    createdAt,
                    updatedAt: createdAt,
                    pendingTranslations: 0,
                    originalVisible: 0,
                    translationVisible: this._reducedMotion ? textLength(chunk) : 0,
                    originalAnimationStartedAt: 0,
                    translationAnimationStartedAt: createdAt,
                };
                this.segments.push(newSeg);
                this.sessionLog.push({ ...newSeg });
            }
        }
        this._announce(chunk);
        this._render();
        this._queueTypewriter();
    }

    /**
     * Update provisional (in-progress) text
     */
    setProvisional(text, speaker, language) {
        this._removeListening();
        const nextText = text || '';
        const previousVisible = this.provisionalVisible;
        const wasCaughtUp = previousVisible >= textLength(this.provisionalText);
        const stablePrefix = commonPrefixLength(this.provisionalText, nextText);
        this.provisionalVisible = this._reducedMotion
            ? textLength(nextText)
            : Math.min(this.provisionalVisible, stablePrefix);
        const revisionTouchedVisibleText = stablePrefix < previousVisible;
        if (!nextText) {
            this._provisionalStartedAt = 0;
        } else if (!this._provisionalStartedAt || wasCaughtUp || revisionTouchedVisibleText) {
            this._provisionalStartedAt = Date.now();
        }
        this.provisionalText = nextText;
        this.provisionalSpeaker = speaker || null;
        this.provisionalLanguage = language || null;
        this._render();
        this._queueTypewriter();
    }

    /**
     * Clear provisional text
     */
    clearProvisional({ keepTranslation = false } = {}) {
        this.provisionalText = '';
        this.provisionalSpeaker = null;
        this.provisionalLanguage = null;
        this.provisionalVisible = 0;
        this._provisionalStartedAt = 0;
        if (!keepTranslation) {
            this.translationProvisionalText = '';
            this.translationProvisionalVisible = 0;
            this._translationProvisionalStartedAt = 0;
        }
        this._render();
    }

    /**
     * Replaceable live translation of the current provisional source turn.
     * Never persisted to sessionLog / TTS — finals use addTranslation().
     */
    setTranslationProvisional(text) {
        this._removeListening();
        const nextText = text || '';
        const previous = this.translationProvisionalText || '';
        const previousVisible = this.translationProvisionalVisible;
        const stablePrefix = commonPrefixLength(previous, nextText);
        this.translationProvisionalVisible = this._reducedMotion
            ? textLength(nextText)
            : Math.min(previousVisible, stablePrefix);
        if (!nextText) {
            this._translationProvisionalStartedAt = 0;
            this.translationProvisionalVisible = 0;
        } else if (!this._translationProvisionalStartedAt || this.translationProvisionalVisible >= textLength(previous)) {
            this._translationProvisionalStartedAt = Date.now();
        }
        this.translationProvisionalText = nextText;
        this._render();
        this._queueTypewriter();
    }

    clearTranslationProvisional() {
        this.translationProvisionalText = '';
        this.translationProvisionalVisible = 0;
        this._translationProvisionalStartedAt = 0;
        this._render();
    }

    /**
     * Set source-side provisional (OpenAI Realtime only). Renders on the source
     * panel in dual view; ignored in single view (which shows target only).
     */
    setSourceProvisional(text) {
        this._removeListening();
        const nextText = text || '';
        const previousVisible = this.sourceProvisionalVisible;
        const wasCaughtUp = previousVisible >= textLength(this.sourceProvisionalText);
        const stablePrefix = commonPrefixLength(this.sourceProvisionalText, nextText);
        this.sourceProvisionalVisible = this._reducedMotion
            ? textLength(nextText)
            : Math.min(this.sourceProvisionalVisible, stablePrefix);
        const revisionTouchedVisibleText = stablePrefix < previousVisible;
        if (!nextText) {
            this._sourceProvisionalStartedAt = 0;
        } else if (!this._sourceProvisionalStartedAt || wasCaughtUp || revisionTouchedVisibleText) {
            this._sourceProvisionalStartedAt = Date.now();
        }
        this.sourceProvisionalText = nextText;
        this._render();
        this._queueTypewriter();
    }

    clearSourceProvisional() {
        this.sourceProvisionalText = '';
        this.sourceProvisionalVisible = 0;
        this._sourceProvisionalStartedAt = 0;
        this._render();
    }

    /**
     * Check if there is any content to display
     */
    hasContent() {
        return this.segments.length > 0 || this.provisionalText || this.sourceProvisionalText
            || this.translationProvisionalText
            || !!this.container.querySelector('.listening-indicator');
    }

    /**
     * Show placeholder state
     */
    showPlaceholder() {
        this._stopTypewriter();
        this.container.innerHTML = `
            <div class="transcript-placeholder">
                <div class="transcript-empty-mark" aria-hidden="true">
                    <span></span><span></span><span></span><span></span><span></span>
                </div>
                <p class="transcript-empty-kicker">Live interpretation</p>
                <h2>Speak naturally.<br><span>Translation follows.</span></h2>
                <p class="transcript-empty-copy">Your original speech and translation stay aligned as the conversation unfolds.</p>
                <span class="shortcut-hint">⌘ Enter&nbsp;&nbsp;to start</span>
            </div>
        `;
        this.segments = [];
        this.sessionLog = [];
        this.provisionalText = '';
        this.provisionalSpeaker = null;
        this.provisionalLanguage = null;
        this.sourceProvisionalText = '';
        this.provisionalVisible = 0;
        this.sourceProvisionalVisible = 0;
        this.translationProvisionalText = '';
        this.translationProvisionalVisible = 0;
        this.currentSpeaker = null;
        this.currentLanguage = null;
        this.lastConfidence = null;
        this.contentEl = null;
    }

    /**
     * Show listening state
     */
    showListening() {
        // Remove existing indicators first (prevent duplicates)
        this.container.querySelectorAll('.listening-indicator').forEach(el => el.remove());

        const placeholder = this.container.querySelector('.transcript-placeholder');
        if (placeholder) placeholder.remove();

        this._ensureContent();

        const indicator = document.createElement('div');
        indicator.className = 'listening-indicator';
        indicator.innerHTML = `
            <div class="listening-waves">
                <span></span><span></span><span></span><span></span><span></span>
            </div>
            <p class="listening-kicker">Listening</p>
            <strong>Start speaking when you're ready</strong>
            <small>Live transcript will appear here</small>
        `;
        this.contentEl.appendChild(indicator);
    }

    /**
     * Show status message in transcript area (e.g. loading model)
     */
    showStatusMessage(message) {
        this._ensureContent();
        let statusEl = this.contentEl.querySelector('.pipeline-status');
        if (!statusEl) {
            statusEl = document.createElement('div');
            statusEl.className = 'pipeline-status';
            statusEl.style.cssText = 'text-align:center; padding:8px; color:rgba(255,255,255,0.5); font-size:13px;';
            this.contentEl.appendChild(statusEl);
        }
        statusEl.textContent = message;
    }

    /**
     * Remove status message
     */
    removeStatusMessage() {
        if (this.contentEl) {
            const statusEl = this.contentEl.querySelector('.pipeline-status');
            if (statusEl) statusEl.remove();
        }
    }

    /**
     * Get transcript as plain text for copying
     */
    getPlainText() {
        let lines = [];
        for (const seg of this.segments) {
            if (seg.original) lines.push(seg.original);
            if (seg.translation) lines.push(seg.translation);
            if (seg.original || seg.translation) lines.push('');
        }
        if (this.provisionalText) lines.push(this.provisionalText);
        return lines.join('\n').trim();
    }

    /**
     * Get formatted content for saving to file (markdown with metadata)
     */
    getFormattedContent(metadata = {}) {
        if (this.segments.length === 0) return null;

        const lines = [];

        // Metadata header
        lines.push('---');
        lines.push(`date: ${new Date().toISOString()}`);
        if (metadata.model) lines.push(`model: ${metadata.model}`);
        if (metadata.sourceLang) lines.push(`source_language: ${metadata.sourceLang}`);
        if (metadata.targetLang) lines.push(`target_language: ${metadata.targetLang}`);
        if (metadata.duration) lines.push(`recording_duration: ${metadata.duration}`);
        if (metadata.audioSource) lines.push(`audio_source: ${metadata.audioSource}`);
        lines.push(`segments: ${this.segments.length}`);
        lines.push('---');
        lines.push('');

        // Transcript entries
        for (const seg of this.segments) {
            if (seg.speaker) lines.push(`**Speaker ${seg.speaker}:**`);
            if (seg.original) lines.push(`> ${seg.original}`);
            if (seg.translation) lines.push(seg.translation);
            lines.push('');
        }

        return lines.join('\n').trim();
    }

    /**
     * Check if there are segments to save
     */
    hasSegments() {
        return this.segments.length > 0;
    }

    /**
     * Check if sessionLog has content (full session, not display buffer)
     */
    hasSessionContent() {
        return this.sessionLog.length > 0;
    }

    /**
     * Get full session text from sessionLog (never trimmed).
     * Returns formatted markdown with all segments.
     */
    getFullSessionText(metadata = {}) {
        if (this.sessionLog.length === 0) return null;

        const lines = [];

        // YAML frontmatter
        lines.push('---');
        const now = new Date();
        lines.push(`date: ${now.toISOString().slice(0, 10)}`);
        lines.push(`time: ${now.toTimeString().slice(0, 8)}`);
        if (metadata.duration) lines.push(`duration: ${metadata.duration}`);
        if (metadata.sourceLang) lines.push(`source_lang: ${metadata.sourceLang}`);
        if (metadata.targetLang) lines.push(`target_lang: ${metadata.targetLang}`);
        if (metadata.mode) lines.push(`mode: ${metadata.mode}`);
        if (metadata.audioSource) lines.push(`audio_source: ${metadata.audioSource}`);
        if (metadata.model) lines.push(`model: ${metadata.model}`);
        lines.push(`segments: ${this.sessionLog.length}`);
        lines.push('---');
        lines.push('');

        // Transcript entries
        for (const seg of this.sessionLog) {
            if (seg.speaker) lines.push(`**Speaker ${seg.speaker}:**`);
            if (seg.original) lines.push(`> ${seg.original}`);
            if (seg.translation) lines.push(seg.translation);
            lines.push('');
        }

        return lines.join('\n').trim();
    }

    /**
     * Clear session log (call after saving)
     */
    clearSession() {
        this.sessionLog = [];
    }

    /**
     * Clear display buffer only (segments array).
     * sessionLog is NOT cleared — use clearSession() explicitly.
     */
    clear() {
        this._stopTypewriter();
        this.container.innerHTML = '';
        this.segments = [];
        this.provisionalText = '';
        this.provisionalSpeaker = null;
        this.provisionalLanguage = null;
        this.sourceProvisionalText = '';
        this.provisionalVisible = 0;
        this.sourceProvisionalVisible = 0;
        this.translationProvisionalText = '';
        this.translationProvisionalVisible = 0;
        this.currentSpeaker = null;
        this.currentLanguage = null;
        this.lastConfidence = null;
        this.contentEl = null;
    }

    /**
     * Update confidence score
     */
    setConfidence(confidence) {
        this.lastConfidence = confidence;
    }

    // ─── Internal ──────────────────────────────────────────

    _ensureContent() {
        if (!this.contentEl) {
            this.container.innerHTML = '';
            this.contentEl = document.createElement('div');
            this.contentEl.className = 'transcript-flow';
            this.container.appendChild(this.contentEl);
        }
    }

    _removeListening() {
        const indicator = this.container.querySelector('.listening-indicator');
        if (indicator) indicator.remove();
    }

    _announce(text) {
        const announcer = document.getElementById('transcript-announcer');
        if (announcer && text) announcer.textContent = text;
    }

    _queueTypewriter() {
        if (this._reducedMotion || typeof requestAnimationFrame !== 'function') {
            if (this._revealAllText()) this._render();
            return;
        }
        if (this._animationFrame !== null) return;
        this._animationLastAt = Date.now();
        this._animationFrame = requestAnimationFrame(this._tickTypewriter);
    }

    _stopTypewriter() {
        if (this._animationFrame !== null && typeof cancelAnimationFrame === 'function') {
            cancelAnimationFrame(this._animationFrame);
        }
        this._animationFrame = null;
        this._animationLastAt = 0;
    }

    _revealAllText() {
        let changed = false;
        for (const seg of this.segments) {
            const originalTotal = textLength(seg.original || '');
            const translationTotal = textLength(seg.translation || '');
            if ((seg.originalVisible ?? originalTotal) !== originalTotal) changed = true;
            if ((seg.translationVisible ?? translationTotal) !== translationTotal) changed = true;
            seg.originalVisible = originalTotal;
            seg.translationVisible = translationTotal;
        }
        const provisionalTotal = textLength(this.provisionalText);
        const sourceProvisionalTotal = textLength(this.sourceProvisionalText);
        const translationProvisionalTotal = textLength(this.translationProvisionalText);
        if (this.provisionalVisible !== provisionalTotal) changed = true;
        if (this.sourceProvisionalVisible !== sourceProvisionalTotal) changed = true;
        if (this.translationProvisionalVisible !== translationProvisionalTotal) changed = true;
        this.provisionalVisible = provisionalTotal;
        this.sourceProvisionalVisible = sourceProvisionalTotal;
        this.translationProvisionalVisible = translationProvisionalTotal;
        return changed;
    }

    _animationTracks() {
        const tracks = [];
        this.segments.forEach((seg, index) => {
            const originalTotal = textLength(seg.original || '');
            const translationTotal = textLength(seg.translation || '');
            if ((seg.originalVisible ?? originalTotal) < originalTotal) {
                tracks.push({
                    owner: seg,
                    field: 'originalVisible',
                    total: originalTotal,
                    startedAt: seg.originalAnimationStartedAt || seg.createdAt,
                    historical: index < this.segments.length - 1,
                });
            }
            if ((seg.translationVisible ?? translationTotal) < translationTotal) {
                tracks.push({
                    owner: seg,
                    field: 'translationVisible',
                    total: translationTotal,
                    startedAt: seg.translationAnimationStartedAt || seg.createdAt,
                    historical: index < this.segments.length - 1,
                });
            }
        });
        if (this.provisionalVisible < textLength(this.provisionalText)) {
            tracks.push({
                owner: this,
                field: 'provisionalVisible',
                total: textLength(this.provisionalText),
                startedAt: this._provisionalStartedAt || Date.now(),
                historical: false,
            });
        }
        if (this.sourceProvisionalVisible < textLength(this.sourceProvisionalText)) {
            tracks.push({
                owner: this,
                field: 'sourceProvisionalVisible',
                total: textLength(this.sourceProvisionalText),
                startedAt: this._sourceProvisionalStartedAt || Date.now(),
                historical: false,
            });
        }
        if (this.translationProvisionalVisible < textLength(this.translationProvisionalText)) {
            tracks.push({
                owner: this,
                field: 'translationProvisionalVisible',
                total: textLength(this.translationProvisionalText),
                startedAt: this._translationProvisionalStartedAt || Date.now(),
                historical: false,
            });
        }
        return tracks;
    }

    _tickTypewriter() {
        this._animationFrame = null;
        const now = Date.now();
        const elapsedMs = Math.max(8, now - (this._animationLastAt || now - 16));
        this._animationLastAt = now;
        const tracks = this._animationTracks();
        let changed = false;

        for (const track of tracks) {
            const current = track.owner[track.field] || 0;
            const next = track.historical
                ? track.total
                : nextRevealCount({
                    visible: current,
                    total: track.total,
                    elapsedMs,
                    ageMs: now - track.startedAt,
                    queuedTracks: tracks.length,
                });
            if (next !== current) {
                track.owner[track.field] = next;
                changed = true;
            }
        }

        if (changed) this._render();
        if (this._animationTracks().length > 0) {
            this._animationFrame = requestAnimationFrame(this._tickTypewriter);
        } else {
            this._animationLastAt = 0;
        }
    }

    _animatedMarkup(text, visibleCount) {
        const fullText = text || '';
        const total = textLength(fullText);
        const shown = visibleText(fullText, visibleCount ?? total);
        const typing = textLength(shown) < total;
        return `<span class="typewriter-text" aria-hidden="true">${this._esc(shown)}</span>${typing
            ? '<span class="typewriter-caret" aria-hidden="true"></span>'
            : ''}`;
    }

    _languageLabel(code, fallback) {
        const value = (code || fallback || 'auto').trim();
        return value.toLowerCase() === 'auto' ? 'AUTO' : value.toUpperCase();
    }

    _stageHeader({ single = false } = {}) {
        const source = this._languageLabel(this.sourceLanguage, 'auto');
        const target = this._languageLabel(this.targetLanguage, 'vi');
        if (single) {
            return `
                <header class="transcript-stage-header single-header">
                    <div class="stage-heading-cell target-heading">
                        <span class="stage-eyebrow">Live translation</span>
                        <span class="stage-language">${this._esc(target)}</span>
                    </div>
                </header>`;
        }
        return `
            <header class="transcript-stage-header">
                <div class="stage-heading-cell">
                    <span class="stage-eyebrow">Original speech</span>
                    <span class="stage-language">${this._esc(source)}</span>
                </div>
                <span class="stage-direction" aria-hidden="true">→</span>
                <div class="stage-heading-cell target-heading">
                    <span class="stage-eyebrow">Live translation</span>
                    <span class="stage-language">${this._esc(target)}</span>
                </div>
            </header>`;
    }

    _pairMeta(seg) {
        const speaker = seg.speaker
            ? `<span class="speaker-label">Speaker ${this._esc(String(seg.speaker))}</span>`
            : '';
        const language = seg.language
            ? `<span class="lang-badge">${this._esc(this._langEmoji(seg.language))}</span>`
            : '';
        return speaker || language ? `<div class="pair-meta">${speaker}${language}</div>` : '';
    }

    _render() {
        this._ensureContent();
        this._trimSegments();

        // Qwen Live Flash is translation-only (no source transcript channel),
        // so force single-panel even when the user picked dual view — otherwise
        // the source panel sits empty / shows dim provisional noise.
        if (this.viewMode === 'dual' && this.provider !== 'qwen') {
            this._renderDual();
        } else {
            this._renderSingle();
        }
    }

    _renderSingle() {
        const scrollState = this._getScrollState(this.container);
        let rows = '';
        const translated = this.segments.filter(seg => seg.status === 'translated' && seg.translation);
        const draft = this._liveDraftState();
        const liveTranslation = this.translationProvisionalText;
        const isTargetStream = Boolean(this.sourceProvisionalText) || this.provider === 'qwen';
        const latest = this.segments[this.segments.length - 1];
        const recentFinal = isTargetStream || liveTranslation ? latest?.translation : latest?.original;
        const displayProvisional = draft.attach
            ? ''
            : (liveTranslation
                ? (repeatsRecentTail(recentFinal, liveTranslation) ? '' : liveTranslation)
                : (repeatsRecentTail(recentFinal, this.provisionalText) ? '' : this.provisionalText));
        const provisionalVisible = liveTranslation
            ? this.translationProvisionalVisible
            : this.provisionalVisible;

        translated.forEach((seg, index) => {
            const total = textLength(seg.translation);
            const visible = seg.translationVisible ?? total;
            const isLast = index === translated.length - 1;
            const tail = isLast && draft.attach
                ? (liveTranslation ? draft.targetText : draft.sourceText)
                : '';
            const typing = visible < total || !!tail;
            const confidenceClass = (seg.confidence !== null && seg.confidence < 0.7)
                ? ' low-confidence'
                : '';
            const currentClass = isLast ? ' is-current' : '';
            rows += `
                <article class="translation-line${currentClass}${typing ? ' is-typing' : ''}">
                    ${this._pairMeta(seg)}
                    <p class="translation-copy${confidenceClass}" aria-label="${this._esc(seg.translation)}">
                        ${this._animatedMarkup(seg.translation, visible)}${tail
                            ? `<span class="source-draft live-tail">${this._animatedMarkup(tail, provisionalVisible)}</span>`
                            : ''}
                    </p>
                </article>`;
        });

        if (displayProvisional) {
            rows += `
                <article class="translation-line provisional-line is-current is-typing">
                    <div class="pair-meta">
                        <span class="live-draft-label">${isTargetStream || liveTranslation ? 'Translating' : 'Recognizing speech'}</span>
                    </div>
                    <p class="translation-copy ${isTargetStream || liveTranslation ? '' : 'source-draft'}" aria-label="${this._esc(displayProvisional)}">
                        ${this._animatedMarkup(displayProvisional, provisionalVisible)}
                    </p>
                </article>`;
        }

        this.contentEl.innerHTML = `
            <section class="transcript-stage transcript-stage-single" aria-label="Live translated transcript">
                ${this._stageHeader({ single: true })}
                <div class="translation-lines">${rows}</div>
            </section>`;
        this._restoreScroll(this.container, scrollState);
    }

    _renderDual() {
        const scrollState = this._getScrollState(this.container);
        let pairs = '';
        const draft = this._liveDraftState();

        this.segments.forEach((seg, index) => {
            const originalTotal = textLength(seg.original || '');
            const translationTotal = textLength(seg.translation || '');
            const originalVisible = seg.originalVisible ?? originalTotal;
            const translationVisible = seg.translationVisible ?? translationTotal;
            const isLast = index === this.segments.length - 1;
            const sourceDraft = isLast && draft.attach ? draft.sourceText : '';
            const targetDraft = isLast && draft.attach ? draft.targetText : '';
            const sourceTyping = originalVisible < originalTotal || !!sourceDraft;
            const targetTyping = translationVisible < translationTotal || !!targetDraft;
            const isPending = (seg.pendingTranslations || 0) > 0
                || seg.status === 'original'
                || !seg.translation
                || !!targetDraft;
            const confidenceClass = (seg.confidence !== null && seg.confidence < 0.7)
                ? ' low-confidence'
                : '';
            const isCurrent = isLast;
            pairs += `
                <article class="transcript-pair${isCurrent ? ' is-current' : ''}${sourceTyping || targetTyping ? ' is-typing' : ''}">
                    <div class="pair-cell pair-source">
                        ${this._pairMeta(seg)}
                        <p class="pair-copy source-copy" aria-label="${this._esc((seg.original || '') + (sourceDraft ? ` ${sourceDraft}` : ''))}">
                            ${seg.original
                                ? this._animatedMarkup(seg.original, originalVisible)
                                : (!sourceDraft ? '<span class="empty-copy" aria-hidden="true">Source unavailable</span>' : '')}
                            ${sourceDraft
                                ? `<span class="source-draft live-tail">${this._animatedMarkup(sourceDraft, draft.sourceVisible)}</span>`
                                : ''}
                        </p>
                    </div>
                    <div class="pair-direction" aria-hidden="true"><span>→</span></div>
                    <div class="pair-cell pair-target">
                        <div class="pair-meta target-meta">
                            <span class="${isPending ? 'translating-label' : 'translated-label'}">${isPending ? 'Translating' : 'Translated'}</span>
                        </div>
                        <p class="pair-copy target-copy${confidenceClass}" aria-label="${this._esc((seg.translation || '') + (targetDraft ? ` ${targetDraft}` : '') || 'Translation pending')}">
                            ${seg.translation ? this._animatedMarkup(seg.translation, translationVisible) : ''}
                            ${targetDraft
                                ? `<span class="source-draft live-tail">${this._animatedMarkup(targetDraft, draft.targetVisible)}</span>`
                                : ''}
                            ${isPending && !targetDraft
                                ? `<span class="translation-pending${seg.translation ? ' is-inline' : ''}" aria-hidden="true"><i></i><i></i><i></i></span>`
                                : ''}
                        </p>
                    </div>
                </article>`;
        });

        if (!draft.attach && (this.sourceProvisionalText || this.provisionalText || this.translationProvisionalText)) {
            const usingOpenAi = draft.usingOpenAi;
            const sourceText = draft.sourceText;
            const targetText = draft.targetText;
            const sourceVisible = draft.sourceVisible;
            const targetVisible = draft.targetVisible;
            if (sourceText || targetText) pairs += `
                <article class="transcript-pair provisional-pair is-current is-typing">
                    <div class="pair-cell pair-source">
                        <div class="pair-meta"><span class="live-draft-label">Listening live</span></div>
                        <p class="pair-copy source-copy source-draft" aria-label="${this._esc(sourceText || 'Listening')}">
                            ${sourceText
                                ? this._animatedMarkup(sourceText, sourceVisible)
                                : '<span class="translation-pending" aria-hidden="true"><i></i><i></i><i></i></span>'}
                        </p>
                    </div>
                    <div class="pair-direction" aria-hidden="true"><span>→</span></div>
                    <div class="pair-cell pair-target">
                        <div class="pair-meta target-meta"><span class="translating-label">Translating</span></div>
                        <p class="pair-copy target-copy" aria-label="${this._esc(targetText || 'Translation pending')}">
                            ${targetText
                                ? this._animatedMarkup(targetText, targetVisible)
                                : '<span class="translation-pending" aria-hidden="true"><i></i><i></i><i></i></span>'}
                        </p>
                    </div>
                </article>`;
        }

        this.contentEl.innerHTML = `
            <section class="transcript-stage" aria-label="Live original and translated transcript">
                ${this._stageHeader()}
                <div class="transcript-pairs">${pairs}</div>
            </section>`;
        this._restoreScroll(this.container, scrollState);
    }

    _getScrollState(el) {
        return {
            nearBottom: (el.scrollHeight - el.scrollTop - el.clientHeight) < 100,
            scrollTop: el.scrollTop
        };
    }

    _restoreScroll(el, state) {
        if (!el || !state) return;
        if (state.nearBottom) {
            el.scrollTop = el.scrollHeight;
        } else {
            el.scrollTop = state.scrollTop;
        }
    }

    _smartScroll(el) {
        const isNearBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < 100;
        if (isNearBottom) {
            el.scrollTop = el.scrollHeight;
        }
    }

    _canAttachLiveDraft(last) {
        if (!last) return false;
        if (this.provisionalSpeaker && last.speaker && this.provisionalSpeaker !== last.speaker) return false;
        if (!sameConversationLanguage(this.provisionalLanguage, last.language)) return false;
        const lastAt = last.updatedAt || last.createdAt || 0;
        if (Date.now() - lastAt > MERGE_MAX_GAP_MS) return false;
        const committed = last.original || last.translation || '';
        return committed.length <= MERGE_MAX_CHARS;
    }

    _liveDraftState() {
        const usingOpenAi = this.provider === 'openai';
        const rawSource = usingOpenAi ? this.sourceProvisionalText : this.provisionalText;
        const rawTarget = usingOpenAi ? this.provisionalText : this.translationProvisionalText;
        const last = this.segments[this.segments.length - 1];
        const sourceText = liveRemainder(last?.original, rawSource);
        const targetText = liveRemainder(last?.translation, rawTarget);
        return {
            usingOpenAi,
            attach: this._canAttachLiveDraft(last),
            sourceText,
            targetText,
            sourceVisible: usingOpenAi ? this.sourceProvisionalVisible : this.provisionalVisible,
            targetVisible: usingOpenAi ? this.provisionalVisible : this.translationProvisionalVisible,
            hasLooseDraft: !!(sourceText || targetText),
        };
    }

    _canMergeOriginal(last, chunk, speaker, language) {
        if (!last?.original) return false;
        if (speaker && last.speaker && speaker !== last.speaker) return false;
        if (!sameConversationLanguage(language, last.language)) return false;
        const lastAt = last.updatedAt || last.createdAt || 0;
        if (Date.now() - lastAt > MERGE_MAX_GAP_MS) return false;
        const combined = joinSpeech(last.original, chunk);
        if (combined.length > MERGE_MAX_CHARS) return false;
        return true;
    }

    _canMergeTranslationOnly(last, chunk) {
        if (!last?.translation || last.original || (last.pendingTranslations || 0) > 0) return false;
        const lastAt = last.updatedAt || last.createdAt || 0;
        if (Date.now() - lastAt > MERGE_MAX_GAP_MS) return false;
        const combined = joinSpeech(last.translation, chunk);
        return combined.length <= MERGE_MAX_CHARS;
    }

    _trimSegments() {
        let totalLen = 0;
        for (const seg of this.segments) {
            totalLen += (seg.translation || seg.original || '').length;
        }
        while (totalLen > this.maxChars && this.segments.length > 2) {
            const removed = this.segments.shift();
            totalLen -= (removed.translation || removed.original || '').length;
        }
    }

    /**
     * Cap pending originals waiting on translation. Do not time-delete them —
     * slow translation (429 / chain fallback) must not wipe visible transcript.
     */
    _cleanupStaleOriginals() {
        const MAX_PENDING = 8;
        let pending = this.segments.filter((s) => s.status === 'original');
        while (pending.length > MAX_PENDING) {
            const oldest = pending.shift();
            const idx = this.segments.indexOf(oldest);
            if (idx !== -1) this.segments.splice(idx, 1);
        }
    }

    _esc(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Get language flag emoji + code
     */
    _langEmoji(langCode) {
        const flags = {
            'en': '🇬🇧', 'ja': '🇯🇵', 'ko': '🇰🇷', 'zh': '🇨🇳',
            'vi': '🇻🇳', 'fr': '🇫🇷', 'de': '🇩🇪', 'es': '🇪🇸',
            'th': '🇹🇭', 'id': '🇮🇩', 'pt': '🇵🇹', 'ru': '🇷🇺',
            'ar': '🇸🇦', 'hi': '🇮🇳', 'it': '🇮🇹', 'nl': '🇳🇱',
            'pl': '🇵🇱', 'tr': '🇹🇷', 'sv': '🇸🇪', 'da': '🇩🇰',
            'no': '🇳🇴', 'fi': '🇫🇮', 'el': '🇬🇷', 'cs': '🇨🇿',
            'ro': '🇷🇴', 'hu': '🇭🇺', 'uk': '🇺🇦', 'he': '🇮🇱',
            'ms': '🇲🇾', 'tl': '🇵🇭', 'bn': '🇧🇩', 'ta': '🇱🇰',
        };
        const flag = flags[langCode] || '🌐';
        return `${flag} ${langCode.toUpperCase()}`;
    }
}

/**
 * Adaptive typewriter timing for live speech transcripts.
 *
 * The animation is intentionally time-bounded: it should add texture, not
 * latency. Longer phrases type faster, queued phrases accelerate, and no
 * track is allowed to remain visually behind for more than MAX_VISUAL_LAG_MS.
 */

export const MAX_VISUAL_LAG_MS = 760;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function commonPrefixLength(previous = '', next = '') {
    const previousChars = Array.from(String(previous));
    const nextChars = Array.from(String(next));
    const limit = Math.min(previousChars.length, nextChars.length);
    let index = 0;
    while (index < limit && previousChars[index] === nextChars[index]) index += 1;
    return index;
}

export function nextRevealCount({
    visible = 0,
    total = 0,
    elapsedMs = 16,
    ageMs = 0,
    queuedTracks = 1,
} = {}) {
    if (total <= 0 || visible >= total) return Math.max(0, total);
    if (ageMs >= MAX_VISUAL_LAG_MS) return total;

    const remaining = total - visible;
    const desiredDurationMs = clamp(total * 8.5, 210, 620);
    const baseCharsPerSecond = total / (desiredDurationMs / 1000);
    const backlogBoost = 1 + Math.min(1.25, (remaining / Math.max(total, 1)) * 0.85);
    const queueBoost = 1 + Math.min(1.5, Math.max(0, queuedTracks - 1) * 0.5);
    const ageBoost = ageMs > 440 ? 1.65 : 1;
    const charsPerSecond = baseCharsPerSecond * backlogBoost * queueBoost * ageBoost;
    const advance = Math.max(1, Math.ceil(charsPerSecond * clamp(elapsedMs, 8, 80) / 1000));

    return Math.min(total, visible + advance);
}

export function textLength(text = '') {
    return Array.from(String(text)).length;
}

export function visibleText(text = '', count = 0) {
    return Array.from(String(text)).slice(0, Math.max(0, count)).join('');
}

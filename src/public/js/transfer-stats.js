/**
 * Shared transfer-statistics formatting helpers.
 *
 * Used by both receive.html and send.html to format progress displays
 * such as "42%  1.2 MB/s  14s". Pure functions with no side-effects.
 */

/**
 * Format a byte-per-second rate as a human-readable string.
 * @param {number} bytesPerSec
 * @returns {string} e.g. "1.2 MB/s" or "345 kB/s"
 */
function formatRate(bytesPerSec) {
    if (bytesPerSec >= 1024 * 1024) return (bytesPerSec / (1024 * 1024)).toFixed(1) + ' MB/s';
    return (bytesPerSec / 1024).toFixed(0) + ' kB/s';
}

/**
 * Build the one-line transfer-stats label shown below the progress bar.
 * @param {number} percent   0–100
 * @param {number} rate      bytes per second
 * @param {number} remaining seconds until completion (may be Infinity)
 * @returns {string} e.g. "42%  1.2 MB/s  14s"
 */
function formatTransferStats(percent, rate, remaining) {
    let s = percent + '%  ' + formatRate(rate);
    if (isFinite(remaining) && remaining > 10) {
        const m = Math.floor(remaining / 60);
        const sec = Math.round(remaining % 60);
        s += '  ' + (m > 0 ? m + 'm ' : '') + sec + 's';
    }
    return s;
}

window.formatRate = formatRate;
window.formatTransferStats = formatTransferStats;

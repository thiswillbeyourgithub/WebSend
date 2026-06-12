/**
 * Shared transfer-statistics formatting helpers.
 *
 * Used by both receive.html and send.html to format progress displays
 * such as "42%  1.2 MB/s  14s". Pure functions with no side-effects,
 * plus the attempt-local rate tracker both progress displays share.
 */

/**
 * Attempt-local transfer-rate tracker, shared by the sender and receiver
 * progress displays.
 *
 * Both sides used to divide cumulative progress bytes by the time since
 * the transfer first started, which falls apart after a transient
 * reconnect: the resumed sender keeps full byte credit for the already
 * delivered prefix but restarts its clock (rate inflated), while the
 * receiver's wire-byte counter restarts against the original clock that
 * also spans the outage (rate deflated). In practice the sender displayed
 * roughly twice the receiver's rate for the rest of the file.
 *
 * The tracker instead measures the current attempt: it rebases whenever
 * progress jumps backward (segment rewind, parser re-arm) or after a
 * stall longer than stallMs (reconnect, backpressure stall), so the rate
 * is always bytes actually moved over the time spent moving them.
 *
 * @param {number} stallMs - progress gap that starts a new attempt
 * @returns {{update: function(number, number): number}}
 */
function createRateTracker(stallMs = 3000) {
    let baseAt = null;   // timestamp of the current attempt's baseline
    let baseBytes = 0;   // progress value at that baseline
    let lastAt = 0;
    let lastBytes = 0;
    return {
        /**
         * Record one progress sample and return the attempt-local rate.
         * @param {number} bytes - cumulative progress in bytes
         * @param {number} now   - Date.now()
         * @returns {number} bytes per second (0 until measurable)
         */
        update(bytes, now) {
            if (baseAt === null || bytes < lastBytes || now - lastAt > stallMs) {
                baseAt = now;
                baseBytes = bytes;
            }
            lastAt = now;
            lastBytes = bytes;
            const elapsed = (now - baseAt) / 1000;
            return elapsed > 0 ? (bytes - baseBytes) / elapsed : 0;
        },
    };
}

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
 * @param {number} percent   0-100
 * @param {number} rate      bytes per second
 * @param {number} remaining seconds until completion (may be Infinity)
 * @returns {string} e.g. "42%  1.2 MB/s  14s"
 */
function formatTransferStats(percent, rate, remaining) {
    let s = percent + '%  ' + formatRate(rate);
    // Show the ETA whenever it is known (finite). The only case without a
    // time component is the first ~200ms before any rate is measured, when
    // remaining is Infinity. Previously this was gated on remaining > 10,
    // so the ETA vanished both at the start (rate still 0) and near the end
    // (under 10s), which read as "it appears then goes away".
    if (isFinite(remaining) && remaining >= 0) {
        const m = Math.floor(remaining / 60);
        const sec = Math.round(remaining % 60);
        s += '  ' + (m > 0 ? m + 'm ' : '') + sec + 's';
    }
    return s;
}

window.formatRate = formatRate;
window.formatTransferStats = formatTransferStats;
window.createRateTracker = createRateTracker;

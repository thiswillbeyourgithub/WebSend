/**
 * Shared Screen Wake Lock manager.
 *
 * Both send.html and receive.html need to keep the screen on during active
 * transfers. This module centralizes the acquire/release logic and the
 * re-acquisition after a page-visibility-change event (browsers silently
 * release the lock when the tab is backgrounded).
 *
 * Usage:
 *   wakeLockMgr.desired = true;
 *   await wakeLockMgr.acquire();
 *   ...
 *   wakeLockMgr.release();
 *
 * The visibilitychange re-acquisition is NOT registered here because both
 * pages also perform other work in their own visibilitychange handler. Pages
 * must call `if (wakeLockMgr.desired && !wakeLockMgr.held) wakeLockMgr.acquire()`
 * themselves inside their own handler.
 */

const wakeLockMgr = {
    desired: false,
    _lock: null,

    /** True when the lock is currently held. */
    get held() { return this._lock !== null; },

    /** Request the screen wake lock. No-op if the API is unavailable. */
    async acquire() {
        if (!('wakeLock' in navigator)) return;
        try {
            this._lock = await navigator.wakeLock.request('screen');
            logger.info('Wake lock acquired');
            this._lock.addEventListener('release', () => {
                this._lock = null;
                logger.info('Wake lock released');
            });
        } catch (e) {
            logger.warn('Wake lock request failed: ' + e.message);
        }
    },

    /** Release the wake lock and clear the desired flag. */
    release() {
        this.desired = false;
        if (this._lock) {
            this._lock.release();
            this._lock = null;
        }
    },
};

window.wakeLockMgr = wakeLockMgr;

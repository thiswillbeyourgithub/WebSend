// Owns one scribe.js instance and centralizes its lifecycle.
// Scribe exposes either `clear()` (in-place reset) or `terminate()`
// (full teardown), depending on version. This handle absorbs that
// fork in one place via reset() / dispose().
(function () {
    class ScribeHandle {
        constructor(scribe) {
            this._scribe = scribe;
            this._terminated = false;
        }

        static async create() {
            const m = await import('/scribe/scribe.js');
            const s = m.default;
            await s.init({ ocr: true, font: true });
            s.opt.displayMode = 'invis';
            return new ScribeHandle(s);
        }

        get raw() { return this._scribe; }
        get data() { return this._scribe.data; }
        get isAlive() { return this._scribe !== null && !this._terminated; }

        importFiles(files) { return this._scribe.importFiles(files); }
        recognize(opts) { return this._scribe.recognize(opts); }
        exportData(fmt) { return this._scribe.exportData(fmt); }

        // Reset internal state so the same instance can be reused.
        // Returns true if cleared (instance still usable),
        // false if terminated (instance is gone).
        async reset() {
            if (!this.isAlive) return false;
            const s = this._scribe;
            if (typeof s.clear === 'function') {
                await s.clear();
                return true;
            }
            if (typeof s.terminate === 'function') {
                await s.terminate();
                this._scribe = null;
                this._terminated = true;
                return false;
            }
            return false;
        }

        // Best-effort teardown. Safe to call multiple times.
        async dispose() {
            if (!this.isAlive) return;
            try { await this.reset(); } catch (_) { /* best effort */ }
            this._scribe = null;
            this._terminated = true;
        }
    }

    if (typeof window !== 'undefined') window.ScribeHandle = ScribeHandle;
    if (typeof module !== 'undefined' && module.exports) module.exports = { ScribeHandle };
})();

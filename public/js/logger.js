/**
 * Logger module for ImageSecureSend
 * Provides consistent logging with timestamps and log levels.
 * Logs are stored in memory and can be displayed in a UI panel.
 */

class Logger {
    constructor() {
        this.logs = [];
        this.maxLogs = 500;
        this.listeners = [];
        this.devMode = false; // Set via setDevMode() after fetching /api/config
    }

    /**
     * Enable or disable DEV mode (verbose debug logging)
     * @param {boolean} enabled - Whether DEV mode is enabled
     */
    setDevMode(enabled) {
        this.devMode = enabled;
        if (enabled) {
            this.info('[DEV MODE] Verbose debug logging enabled');
        }
    }

    /**
     * Add a listener that will be called whenever a new log is added
     * @param {Function} callback - Function to call with log entry
     */
    addListener(callback) {
        this.listeners.push(callback);
    }

    /**
     * Format current time as HH:MM:SS.mmm
     * @returns {string} Formatted time string
     */
    getTimeString() {
        const now = new Date();
        const h = String(now.getHours()).padStart(2, '0');
        const m = String(now.getMinutes()).padStart(2, '0');
        const s = String(now.getSeconds()).padStart(2, '0');
        const ms = String(now.getMilliseconds()).padStart(3, '0');
        return `${h}:${m}:${s}.${ms}`;
    }

    /**
     * Add a log entry
     * @param {string} level - Log level (info, success, error, warn)
     * @param {string} message - Log message
     */
    log(level, message) {
        const entry = {
            time: this.getTimeString(),
            level: level,
            message: message
        };

        this.logs.push(entry);

        // Trim old logs if we exceed max
        if (this.logs.length > this.maxLogs) {
            this.logs.shift();
        }

        // Also log to console for debugging
        const consoleMethod = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
        console[consoleMethod](`[${entry.time}] [${level.toUpperCase()}] ${message}`);

        // Notify listeners
        this.listeners.forEach(cb => cb(entry));
    }

    info(message) {
        this.log('info', message);
    }

    success(message) {
        this.log('success', message);
    }

    error(message) {
        this.log('error', message);
    }

    warn(message) {
        this.log('warn', message);
    }

    /**
     * Debug log - only outputs when DEV mode is enabled.
     * Use for verbose handshake/connection details.
     * @param {string} context - Log context (e.g., 'ICE', 'SIGNALING', 'DATACHANNEL')
     * @param {string} message - Log message
     * @param {Object} [data] - Optional data to log
     */
    debug(context, message, data = null) {
        if (!this.devMode) return;
        const dataStr = data ? ` | ${JSON.stringify(data)}` : '';
        this.log('debug', `[${context}] ${message}${dataStr}`);
    }

    /**
     * Get all logs
     * @returns {Array} Array of log entries
     */
    getLogs() {
        return this.logs;
    }

    /**
     * Clear all logs
     */
    clear() {
        this.logs = [];
    }
}

// Create and export singleton instance
window.logger = new Logger();

/**
 * Initialize the logs panel UI
 * Should be called after DOM is ready
 */
function initLogsPanel() {
    // Create toggle button
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'logs-toggle';
    toggleBtn.textContent = 'Logs';
    document.body.appendChild(toggleBtn);

    // Create logs panel
    const panel = document.createElement('div');
    panel.className = 'logs-panel';
    panel.id = 'logs-panel';
    document.body.appendChild(panel);

    // Toggle visibility
    toggleBtn.addEventListener('click', () => {
        panel.classList.toggle('visible');
        if (panel.classList.contains('visible')) {
            toggleBtn.textContent = 'Close Logs';
            renderLogs();
        } else {
            toggleBtn.textContent = 'Logs';
        }
    });

    // Render existing logs
    function renderLogs() {
        panel.innerHTML = '';
        window.logger.getLogs().forEach(entry => {
            appendLogEntry(entry);
        });
        panel.scrollTop = panel.scrollHeight;
    }

    // Append a single log entry to the panel
    function appendLogEntry(entry) {
        const div = document.createElement('div');
        div.className = 'log-entry';

        const levelClass = entry.level === 'error' ? 'log-error' :
                          entry.level === 'success' ? 'log-success' :
                          entry.level === 'debug' ? 'log-debug' :
                          entry.level === 'info' ? 'log-info' : '';

        div.innerHTML = `<span class="log-time">[${entry.time}]</span> <span class="${levelClass}">${escapeHtml(entry.message)}</span>`;
        panel.appendChild(div);

        // Auto-scroll to bottom if panel is visible
        if (panel.classList.contains('visible')) {
            panel.scrollTop = panel.scrollHeight;
        }
    }

    // Listen for new logs
    window.logger.addListener(entry => {
        appendLogEntry(entry);
    });
}

/**
 * Escape HTML to prevent XSS in log messages
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initLogsPanel);
} else {
    initLogsPanel();
}

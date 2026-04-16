# Express server for serving static files and WebRTC signaling
# Using Node.js because it's lightweight and doesn't require compilation
FROM node:20-alpine

WORKDIR /app

# Create non-root user for running the application
# Using a fixed UID/GID to ensure consistent permissions across rebuilds
RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup

# Copy package files
COPY package.json ./

# Install dependencies
RUN npm install --production && \
    # Remove npm cache to reduce image size and attack surface
    npm cache clean --force

# Optional: audit dependencies for known vulnerabilities at build time.
# Disabled by default because it requires network access and the advisory
# database changes independently of your code, making builds non-deterministic.
# Enable with: RUN_NPM_AUDIT=true in your .env (passed as a build arg).
ARG RUN_NPM_AUDIT=false
RUN if [ "$RUN_NPM_AUDIT" = "true" ]; then npm audit --audit-level=high; fi

# Copy application files
COPY server.js ./
COPY public/ ./public/
COPY check-sri.js ./
COPY healthcheck.js ./

# Verify SRI hashes are up to date (fails the build if not)
RUN node check-sri.js

# Change ownership of app files to non-root user
RUN chown -R appuser:appgroup /app

# Switch to non-root user for all subsequent commands and runtime
USER appuser

# Expose port (unprivileged port, no root needed)
EXPOSE 8080

# Healthcheck: verifies Express + configured STUN/TURN/TURNS servers are alive
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node healthcheck.js

# Run the server
CMD ["node", "server.js"]

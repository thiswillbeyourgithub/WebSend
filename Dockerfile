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

# Copy application files
COPY server.js ./
COPY public/ ./public/

# Change ownership of app files to non-root user
RUN chown -R appuser:appgroup /app

# Switch to non-root user for all subsequent commands and runtime
USER appuser

# Expose port (unprivileged port, no root needed)
EXPOSE 8080

# Run the server
CMD ["node", "server.js"]

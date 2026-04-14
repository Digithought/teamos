FROM node:22-slim

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Install rclone (for S3 sync)
RUN apt-get update && apt-get install -y rclone && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY teamos/ ./teamos/

# Working directory for the team workspace (Fly Volume mount point)
RUN mkdir -p /workspace/team

CMD ["node", "teamos/scripts/run.mjs", "--sync", "s3", "--messaging", "file"]

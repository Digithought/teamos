FROM node:22-slim

# System deps:
#   git           — clone/pull the host project, sync commits
#   curl + tar    — install vscode CLI
#   ca-certificates — TLS for git/curl
#   rclone        — optional, used by the s3 sync adapter
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		git curl ca-certificates tar rclone \
	&& rm -rf /var/lib/apt/lists/*

# VSCode CLI — enables `code tunnel` for remote development.
# Skipped at runtime unless TEAMOS_TUNNEL_NAME is set.
RUN curl -fsSL "https://update.code.visualstudio.com/latest/cli-linux-x64/stable" \
		-o /tmp/vscode-cli.tar.gz \
	&& tar -xzf /tmp/vscode-cli.tar.gz -C /usr/local/bin \
	&& rm /tmp/vscode-cli.tar.gz

# Claude Code CLI — invoked per member cycle.
RUN npm install -g @anthropic-ai/claude-code

# Use the `node` user (uid 1000) that ships with the base image. The Claude
# CLI refuses `--dangerously-skip-permissions` under EUID=0 even inside a
# container, so the entrypoint chowns /workspace to this user on boot and
# re-execs itself via `runuser` to drop privileges.

# HOME on the volume so git credentials and vscode-cli auth survive restarts.
ENV HOME=/workspace
WORKDIR /workspace

# TEAMOS_PATH is the path to the teamos directory within the build context.
# Default `.` works when teamos is itself the context root (standalone deploy).
# When deploying from a host project whose build context is the parent repo,
# set `--build-arg TEAMOS_PATH=teamos` so the COPY resolves correctly.
ARG TEAMOS_PATH=.
COPY ${TEAMOS_PATH}/scripts/entrypoint.sh /usr/local/bin/teamos-entrypoint
RUN chmod +x /usr/local/bin/teamos-entrypoint

ENTRYPOINT ["teamos-entrypoint"]
CMD ["--sync", "git", "--push"]

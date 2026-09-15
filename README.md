# Claude Code Telemetry - Recreated Configuration

This directory contains the recreated configuration files for the claude-code-telemetry container that was accidentally deleted.

## What Was Recreated

The following essential files were recreated based on the running container inspection and the original repository:

### Core Files
- `docker-compose.yml` - Docker Compose configuration
- `.env` - Active environment configuration with your Langfuse API keys
- `Dockerfile` - Container build configuration
- `package.json` - Node.js dependencies and scripts
- `src/server.js` - Minimal telemetry server implementation

### Reference Files
- `.env.example` - Template for future reference
- `.gitignore` - Prevents sensitive files from being committed
- `CLAUDE-SETUP.md` - Original setup documentation (preserved)
- `scripts/test-langfuse-connection.py` - Connection test script (preserved)

## Current Status

✅ **Container is running and healthy**
- Container: `claude-code-telemetry-telemetry-server-1`
- Port: `4318`
- Health: Connected to Langfuse at `http://localhost:3020`
- API Keys: Configured and working

## API Keys

`LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are read from `.env` (see
`.env.example`) — do not commit real values here.

## Container Management

### View Status
```bash
cd /home/nole/dev/shared/docker/claude-code-telemetry
docker compose ps
```

### View Logs
```bash
cd /home/nole/dev/shared/docker/claude-code-telemetry
docker compose logs -f telemetry-server
```

### Restart Container
```bash
cd /home/nole/dev/shared/docker/claude-code-telemetry
docker compose restart
```

### Rebuild Container (if needed)
```bash
cd /home/nole/dev/shared/docker/claude-code-telemetry
docker compose down
docker compose build
docker compose up -d
```

### Health Check
```bash
curl http://localhost:4318/health
```

## Original Repository

The container was built from: https://github.com/lainra/claude-code-telemetry

## Notes

- The current implementation is a minimal recreation focused on maintaining container functionality
- All original API keys and configuration have been preserved
- The container continues to work with your existing Langfuse instance
- For full functionality, consider cloning the original repository if needed
# 🚀 Claude Code Telemetry Setup Guide

Complete setup instructions for integrating Claude Code CLI telemetry with your existing Langfuse instance.

## 📋 Overview

This telemetry bridge captures OpenTelemetry data from Claude Code CLI and forwards it to your existing Langfuse project. The integration uses your existing Langfuse API keys, which automatically map to your specific project.

## 🔑 Key Mapping & Project Integration

**✅ Automatic Project Mapping**
- Your Langfuse keys (`pk-lf-de067845...` and `sk-lf-f6889acb...`) are project-specific
- No need to specify project name - keys automatically route data to your existing project
- Telemetry data will appear in the same Langfuse project you're already using
- All existing project settings, users, and data remain unchanged

## 🎯 Current Setup Status

**✅ Completed:**
- Telemetry bridge service is running on port 4318
- Connected to your Langfuse instance at `http://localhost:3020`
- Health check passed: `{"status":"healthy","langfuse":"connected"}`
- Configuration files created with your existing API keys

**🔧 Next Steps:**
- Configure Claude Code CLI to send telemetry data
- Test the integration
- Verify data appears in Langfuse

## 📊 Current Environment Status

### ✅ Already Set:
- `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`
- `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta`

### ❌ Missing Required Variables:
- `CLAUDE_CODE_ENABLE_TELEMETRY=1` - Enables Claude Code telemetry
- `OTEL_LOGS_EXPORTER=otlp` - Required for log export
- `OTEL_METRICS_EXPORTER=otlp` - Required for metrics export
- `OTEL_METRICS_EXPORTER_PROTOCOL=http/json` - Metrics protocol format

### ⚠️ Incorrect Variables:
- `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf` should be `http/json`

The telemetry server expects JSON format, not protobuf.

## 🛠️ Claude Code CLI Configuration

### Option 1: Environment Variables (Recommended)

Add to your `.zshrc` file:

```bash
# Claude Code Telemetry Configuration
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_LOGS_EXPORTER=otlp
export OTEL_METRICS_EXPORTER=otlp
export OTEL_TRACES_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_METRICS_EXPORTER_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318"
# Optional: to see user prompts in telemetry
export OTEL_LOG_USER_PROMPTS=1
```

**Apply immediately:**
```bash
echo '# Claude Code Telemetry Configuration' >> ~/.zshrc
echo 'export CLAUDE_CODE_ENABLE_TELEMETRY=1' >> ~/.zshrc
echo 'export OTEL_LOGS_EXPORTER=otlp' >> ~/.zshrc
echo 'export OTEL_METRICS_EXPORTER=otlp' >> ~/.zshrc
echo 'export OTEL_TRACES_EXPORTER=otlp' >> ~/.zshrc
echo 'export OTEL_EXPORTER_OTLP_PROTOCOL=http/json' >> ~/.zshrc
echo 'export OTEL_METRICS_EXPORTER_PROTOCOL=http/json' >> ~/.zshrc
echo 'export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318"' >> ~/.zshrc
echo 'export OTEL_LOG_USER_PROMPTS=1' >> ~/.zshrc
source ~/.zshrc
```

### Option 2: Session-Specific

For temporary testing in current session:
```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_LOGS_EXPORTER=otlp
export OTEL_METRICS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_METRICS_EXPORTER_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318"
```

### Option 3: Per-Command

Run with telemetry for specific commands:
```bash
CLAUDE_CODE_ENABLE_TELEMETRY=1 \
OTEL_LOGS_EXPORTER=otlp \
OTEL_METRICS_EXPORTER=otlp \
OTEL_EXPORTER_OTLP_PROTOCOL=http/json \
OTEL_METRICS_EXPORTER_PROTOCOL=http/json \
OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318" \
claude "your command here"
```

## 🧪 Testing the Integration

### 1. Check Telemetry Bridge Status
```bash
curl http://localhost:4318/health
```
Expected response:
```json
{"status":"healthy","uptime":xxx,"sessions":0,"requestCount":x,"errorCount":0,"langfuse":"connected"}
```

### 🔥 **CRITICAL: Activating Langfuse Tracing**

**⚠️ Important:** Langfuse dashboard may show "Tracing: Pending" even when the telemetry bridge is connected. 

**✅ Solution:** Run the activation test script to send an actual trace:

```bash
# Navigate to telemetry directory
cd /home/nole/dev/shared/docker/claude-code-telemetry

# Run the test script to activate tracing
python3 scripts/test-langfuse-connection.py
```

**What this does:**
- Sends a real trace to Langfuse via the ingestion API
- Changes dashboard status from "Pending" to "Active"
- Creates a test trace named "telemetry-bridge-test" 
- Verifies the complete data pipeline works

**Expected output:**
```
✅ Langfuse health check passed
📤 Sending test trace to Langfuse...
📊 Response status: 207
✅ Test trace sent successfully to Langfuse!
✅ All tests passed!
🔗 Your telemetry bridge should now be ready to receive Claude Code data
```

**After running this script:**
- Langfuse dashboard will show "Tracing: Active" 
- You'll see the test trace in your dashboard
- Ready to receive real Claude Code telemetry

### 2. Test Claude Code CLI with Telemetry
```bash
# With environment variables set
claude "What is 2+2?"

# Or with explicit variables
CLAUDE_CODE_ENABLE_TELEMETRY=1 \
OTEL_LOGS_EXPORTER=otlp \
OTEL_METRICS_EXPORTER=otlp \
OTEL_EXPORTER_OTLP_PROTOCOL=http/json \
OTEL_METRICS_EXPORTER_PROTOCOL=http/json \
OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318" \
claude "What is 2+2?"
```

### 3. Verify Data in Langfuse
1. Open your Langfuse dashboard: `http://localhost:3020`
2. Login with your existing credentials:
   - Email: `russ.hardie@outlook.com`
   - Password: `59fsxYgMgfySpp!`
3. Check for new traces/sessions appearing in your project

## 📊 What You'll See in Langfuse

**New Data Types:**
- **Traces**: Individual Claude Code commands/conversations
- **Sessions**: Grouped interactions (based on time windows)
- **Usage Metrics**: Token counts, costs, tool usage
- **Performance Data**: Response times, error rates

**Expected Fields:**
- User identification (based on system user)
- Command inputs and outputs
- Tool usage (file operations, searches, etc.)
- Token consumption and costs
- Timestamps and session grouping

## 🔧 Service Management

### Start Service
```bash
cd /home/nole/dev/shared/docker/claude-code-telemetry
docker compose up -d
```

### Stop Service
```bash
cd /home/nole/dev/shared/docker/claude-code-telemetry
docker compose down
```

### View Logs
```bash
cd /home/nole/dev/shared/docker/claude-code-telemetry
docker compose logs -f telemetry-server
```

### Check Status
```bash
cd /home/nole/dev/shared/docker/claude-code-telemetry
docker compose ps
```

## 📁 Configuration Files

**`.env`** - Active configuration (ready to use)
- Contains your Langfuse API keys
- Configured for `localhost:3020`
- Port 4318 for telemetry reception

**`.env.example.configured`** - Template for future reference
- Example configuration with placeholders
- Documentation for all available options

## 🚨 Troubleshooting

### Telemetry Bridge Not Starting
```bash
# Check if port 4318 is in use
netstat -tlnp | grep 4318

# Check Docker logs
docker compose logs telemetry-server
```

### No Data in Langfuse
1. Verify environment variables are set:
   ```bash
   echo $OTEL_EXPORTER_OTLP_ENDPOINT
   echo $OTEL_EXPORTER_OTLP_PROTOCOL
   ```

2. Check telemetry bridge health:
   ```bash
   curl http://localhost:4318/health
   ```

3. Test with verbose Claude output:
   ```bash
   OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318" \
   OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf" \
   claude --verbose "test command"
   ```

### Connection Issues
1. Ensure Langfuse is running:
   ```bash
   curl http://localhost:3020/api/public/health
   ```

2. Check if bridge can reach Langfuse:
   ```bash
   docker compose exec telemetry-server curl http://host.docker.internal:3020/api/public/health
   ```

## 🔐 Security Notes

- API keys are stored in `.env` file (excluded from git)
- Telemetry bridge runs locally on `localhost:4318`
- All data stays within your local environment
- No external services or cloud connections required

## 📝 Next Steps

1. **Configure your shell** with the environment variables
2. **Test with a simple Claude command** to verify data flow
3. **Check your Langfuse dashboard** for incoming telemetry data
4. **Explore the metrics** to understand your Claude Code usage patterns

## 🎉 Success Indicators

You'll know everything is working when:
- ✅ Telemetry bridge shows `"langfuse":"connected"`
- ✅ Claude Code commands complete normally
- ✅ New traces appear in your Langfuse project
- ✅ Usage metrics are being tracked

---

**Need help?** Check the original repository: https://github.com/lainra/claude-code-telemetry
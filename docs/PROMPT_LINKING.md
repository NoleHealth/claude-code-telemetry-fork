# Langfuse Prompt Linking

This feature enables automatic detection and linking of Langfuse prompts to traces and generations in the Claude Code telemetry server. When you use a Langfuse prompt in your Claude conversations, the telemetry will automatically link it to the appropriate prompt version for tracking and analytics.

## Features

- **Automatic Prompt Detection**: Detects `@langfuse-mcp` tags in user messages
- **Two-Tier Caching**: L1 (in-memory) and L2 (Redis) caching for optimal performance
- **Trace Naming**: Changes trace names from `conversation-X` to `p-{promptName}` for easy identification
- **Generation Linking**: Links LLM generations to specific prompt versions
- **Cache Management API**: HTTP endpoints for cache invalidation and status monitoring
- **Metrics Tracking**: Tracks cache hits, misses, and performance metrics

## Usage

### Basic Usage

Include the `@langfuse-mcp` tag in your Claude message:

```
@langfuse-mcp prompt="str-01-02-execute-kick-off" base_path="./docs/project_docs/features/20250819-pages/03-environment-docker/"
Read and Execute the Prompt
```

When Claude processes this message:
1. The prompt name `str-01-02-execute-kick-off` is detected
2. Prompt metadata is fetched from Langfuse (and cached)
3. The trace is named `p-str-01-02-execute-kick-off` instead of `conversation-1`
4. The generation is linked to the prompt version in Langfuse

### Environment Variables

Configure the prompt cache behavior with these environment variables:

```bash
# Redis configuration (default: redis://localhost:6379/0)
REDIS_URL=redis://localhost:6379/0

# L1 Cache (in-memory) TTL in milliseconds (default: 300000 = 5 minutes)
LANGFUSE_PROMPT_CACHE_L1_TTL=300000

# L2 Cache (Redis) TTL in seconds (default: 3600 = 1 hour)
LANGFUSE_PROMPT_CACHE_L2_TTL=3600

# Preload production prompts on startup (default: false)
LANGFUSE_PROMPT_PRELOAD=true
```

## Cache Management API

### Get Cache Status

```bash
GET http://localhost:4001/cache/status
```

Returns:
```json
{
  "l1": {
    "size": 2,
    "ttl": 300,
    "items": [
      {
        "name": "str-01-02-execute-kick-off",
        "version": 3,
        "type": "text",
        "age": 45,
        "labels": ["production"]
      }
    ]
  },
  "l2": {
    "connected": true,
    "size": 5,
    "ttl": 3600,
    "keys": ["str-01-02-execute-kick-off", "another-prompt"]
  },
  "metrics": {
    "hits": { "l1": 150, "l2": 30 },
    "misses": 10,
    "fetches": 10,
    "invalidations": 2,
    "errors": 0,
    "hitRate": {
      "l1": 0.79,
      "l2": 0.16,
      "overall": 0.95
    }
  },
  "config": {
    "l1TTL": "300s",
    "l2TTL": "3600s",
    "redisUrl": "redis://localhost:6379/0"
  }
}
```

### Invalidate Specific Prompt

```bash
POST http://localhost:4001/cache/invalidate
Content-Type: application/json

{
  "promptName": "str-01-02-execute-kick-off"
}
```

### Clear All Caches

```bash
POST http://localhost:4001/cache/invalidate
Content-Type: application/json

{
  "all": true
}
```

## Architecture

### Cache Layers

1. **L1 Cache (In-Memory)**
   - Ultra-fast access (<1ms)
   - 5-minute TTL by default
   - Stores most recently used prompts
   - Cleared on server restart

2. **L2 Cache (Redis)**
   - Persistent across server restarts
   - 1-hour TTL by default
   - Shared across multiple telemetry instances
   - Survives server restarts

### Data Flow

```
User Message with @langfuse-mcp
    ↓
Event Processor (detectLangfusePrompt)
    ↓
Session Handler (handleUserPrompt)
    ↓
Prompt Cache (getPrompt)
    ├─→ L1 Hit? Return immediately
    ├─→ L2 Hit? Update L1, return
    └─→ Miss? Fetch from Langfuse API
         └─→ Update L1 & L2 caches
    ↓
Create Trace with prompt metadata
    ↓
Link Generation to prompt version
```

## Viewing Results in Langfuse

When a prompt is successfully linked:

1. **Trace View**: The trace name shows as `p-{promptName}` instead of `conversation-X`
2. **Generation View**: The generation includes `promptName` and `promptVersion` fields
3. **Prompt Analytics**: You can track metrics by prompt version in the Langfuse UI
4. **Performance Metrics**: Compare performance across different prompt versions

## Troubleshooting

### Cache Not Working

1. Check Redis connection:
```bash
redis-cli ping
# Should return: PONG
```

2. Verify environment variables:
```bash
echo $REDIS_URL
echo $LANGFUSE_PUBLIC_KEY
echo $LANGFUSE_SECRET_KEY
```

3. Check server logs:
```bash
docker logs claude-code-telemetry
```

### Prompts Not Being Detected

1. Ensure the exact format: `@langfuse-mcp prompt="exact-prompt-name"`
2. Verify the prompt exists in Langfuse with a "production" label
3. Check `OTEL_LOG_USER_PROMPTS=1` is set (required to see prompt content)

### Cache Invalidation Not Working

1. Ensure the telemetry server is running
2. Check CORS if calling from a browser
3. Verify the prompt name matches exactly

## Integration with UI

If you have a homelab UI managing your services, you can integrate cache management:

```javascript
// React component example
async function invalidatePromptCache(promptName) {
  const response = await fetch('http://telemetry-server:4001/cache/invalidate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ promptName })
  });
  
  if (response.ok) {
    console.log(`Cache invalidated for ${promptName}`);
  }
}
```

## Performance Considerations

- **L1 Cache**: Keeps hot prompts in memory for <1ms access
- **L2 Cache**: Reduces Langfuse API calls by ~95%
- **Preloading**: Optional startup preload for frequently used prompts
- **TTL Configuration**: Adjust based on prompt update frequency

## Security

- Cache endpoints have no authentication (designed for internal use)
- Add authentication if exposing publicly
- Redis connection should be secured in production
- Prompt content is not cached, only metadata (name, version, labels)

## Future Enhancements

- [ ] Webhook support for automatic cache invalidation on prompt updates
- [ ] Prometheus metrics export for cache performance
- [ ] Support for multiple prompt detection patterns
- [ ] Prompt parameter extraction and validation
- [ ] Cache warming based on usage patterns
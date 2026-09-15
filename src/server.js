#!/usr/bin/env node

/**
 * Claude Code Telemetry Server
 *
 * OTLP-compatible telemetry receiver that captures observability data from Claude Code
 * and forwards it to Langfuse for comprehensive LLM monitoring and analytics.
 *
 * Production-ready implementation with:
 * - Structured logging with pino
 * - Configuration validation
 * - Health check endpoint
 * - Graceful shutdown
 * - Error handling with retries
 * - Request size limits
 */

'use strict'

require('dotenv').config()

const http = require('http')
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node')
const { LangfuseSpanProcessor } = require('@langfuse/otel')
const { setLangfuseTracerProvider } = require('@langfuse/tracing')
const { LangfuseClient } = require('@langfuse/client')
// const { v4: uuidv4 } = require('uuid') // Currently unused
const pino = require('pino')
const { retry } = require('./sessionHandler')
const { handleTraces, handleMetrics, handleLogs, handleHealthCheck } = require('./requestHandlers')
const { PromptCache } = require('./promptCache')
const {
  validateConfig: validateConfigHelper,
  createConfig,
  cleanupSessions: cleanupSessionsHelper,
  finalizeAllSessions,
  handleAuth,
  setCorsHeaders,
  handlePreflight,
  generateStartupBanner,
} = require('./serverHelpers')

// Configuration with validation
const config = createConfig()

// Logger setup
const logger = pino({
  level: config.logLevel,
  transport: config.nodeEnv === 'development'
    ? {
        target: 'pino-pretty',
        options: {
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname',
          colorize: true,
        },
      }
    : undefined,
})

// Validate configuration
function validateConfig() {
  const errors = validateConfigHelper(config)

  if (errors.length > 0) {
    logger.error({ errors }, 'Configuration validation failed')
    const { printConfigHelp } = require('./serverHelpers')
    printConfigHelp()
    process.exit(1)
  }
}

// Initialize Langfuse OTel tracing (traces/generations/events) and REST client (scores/prompts)
const spanProcessor = new LangfuseSpanProcessor({
  publicKey: config.langfuse.publicKey,
  secretKey: config.langfuse.secretKey,
  baseUrl: config.langfuse.baseUrl,
  flushAt: config.langfuse.flushAt,
  // config.langfuse.flushInterval (LANGFUSE_FLUSH_INTERVAL env var) is in milliseconds,
  // matching the old v3 SDK and this deployment's existing .env files. The v4/v5
  // LangfuseSpanProcessor's `flushInterval` is in SECONDS (verified against source:
  // node_modules/@langfuse/otel - it does `Number(flushInterval) * 1000` internally) -
  // convert here rather than changing the env var's long-standing unit.
  flushInterval: config.langfuse.flushInterval / 1000,
})
setLangfuseTracerProvider(new NodeTracerProvider({ spanProcessors: [spanProcessor] }))

const langfuseClient = new LangfuseClient({
  publicKey: config.langfuse.publicKey,
  secretKey: config.langfuse.secretKey,
  baseUrl: config.langfuse.baseUrl,
})

// Bundle handed to SessionHandler: `client` for score/prompt REST calls, `spanProcessor`
// for flushing/shutting down the OTel trace pipeline.
const langfuse = { client: langfuseClient, spanProcessor }

// Initialize Prompt Cache
const promptCache = new PromptCache(langfuseClient, {
  l1TTL: parseInt(process.env.LANGFUSE_PROMPT_CACHE_L1_TTL || '300000', 10), // 5 minutes
  l2TTL: parseInt(process.env.LANGFUSE_PROMPT_CACHE_L2_TTL || '3600', 10), // 1 hour
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379/0',
})

// Optionally preload prompts on startup
if (process.env.LANGFUSE_PROMPT_PRELOAD === 'true') {
  promptCache.preloadPrompts().catch((error) => {
    logger.error({ error }, 'Failed to preload prompts')
  })
}

// Session management
const sessions = new Map()
const serverStartTime = Date.now()
let requestCount = 0
let errorCount = 0

// HTTP Server with request size limit and authentication
const server = http.createServer((req, res) => {
  requestCount++

  // CORS headers
  setCorsHeaders(res)

  // Handle preflight
  if (handlePreflight(req, res)) {
    return
  }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    handleHealthCheck(res, serverStartTime, sessions, requestCount, errorCount)
    return
  }

  // Cache management endpoints (no auth required for internal use)
  if (req.url && req.url.startsWith('/cache/')) {
    // CORS headers for UI access
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    
    // Handle preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(200)
      res.end()
      return
    }
    
    // GET /cache/status
    if (req.method === 'GET' && req.url === '/cache/status') {
      promptCache.getStatus().then((status) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(status, null, 2))
      }).catch((error) => {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: error.message }))
      })
      return
    }
    
    // POST /cache/invalidate
    if (req.method === 'POST' && req.url === '/cache/invalidate') {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString())
          
          if (data.promptName) {
            // Invalidate specific prompt
            promptCache.invalidate(data.promptName).then(() => {
              logger.info(`Cache invalidated for prompt: ${data.promptName}`)
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ 
                success: true, 
                message: `Cache invalidated for prompt: ${data.promptName}` 
              }))
            }).catch((error) => {
              res.writeHead(500, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: error.message }))
            })
          } else if (data.all) {
            // Clear entire cache
            promptCache.clear().then(() => {
              logger.info('Cleared entire prompt cache')
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ 
                success: true, 
                message: 'All caches cleared' 
              }))
            }).catch((error) => {
              res.writeHead(500, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: error.message }))
            })
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Invalid request: specify promptName or all' }))
          }
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Invalid JSON' }))
        }
      })
      return
    }
    
    // Unknown cache endpoint
    res.writeHead(404)
    res.end('Cache endpoint not found')
    return
  }

  // API key authentication if configured
  if (!handleAuth(req, res, config.apiKey)) {
    return
  }

  // Only accept POST requests for telemetry
  if (req.method === 'POST') {
    const chunks = []
    let size = 0

    req.on('data', (chunk) => {
      size += chunk.length
      if (size > config.maxRequestSize) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Request entity too large' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      // Route based on path
      try {
        const body = Buffer.concat(chunks)
        if (req.url === '/v1/traces') {
          handleTraces(body, res, sessions, langfuse)
        } else if (req.url === '/v1/metrics') {
          handleMetrics(body, res, sessions, langfuse, promptCache)
        } else if (req.url === '/v1/logs') {
          handleLogs(body, res, sessions, langfuse, promptCache)
        } else {
          res.writeHead(404)
          res.end('Not found')
        }
      } catch (error) {
        errorCount++
        logger.error({ error, url: req.url }, 'Error handling request')
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Internal server error' }))
      }
    })
  } else {
    res.writeHead(405)
    res.end('Method not allowed')
  }
})

// Session cleanup
function cleanupSessions() {
  cleanupSessionsHelper(sessions, config.sessionTimeout).catch((error) => {
    logger.error({ error }, 'Error during session cleanup')
  })
}

// Schedule periodic cleanup
const cleanupInterval = setInterval(cleanupSessions, 60000) // Every minute
cleanupInterval.unref() // Allow process to exit even if interval is active

// Graceful shutdown
async function shutdown() {
  logger.info('Shutting down gracefully...')

  // Stop accepting new connections
  server.close(() => {
    logger.info('HTTP server closed')
  })

  // Clear cleanup interval
  clearInterval(cleanupInterval)

  // Finalize all active sessions
  await finalizeAllSessions(sessions)

  try {
    await retry(() => Promise.all([spanProcessor.forceFlush(), langfuseClient.flush()]))
    // Shutdown Langfuse SDK to close any remaining connections
    await spanProcessor.shutdown()
    await langfuseClient.shutdown()
  } catch (error) {
    logger.error({ error }, 'Error during Langfuse shutdown')
  }
  
  // Shutdown prompt cache
  await promptCache.shutdown()

  logger.info('Shutdown complete')

  // In test environment, ensure all handles are closed
  if (process.env.NODE_ENV === 'test') {
    // Force close any remaining handles
    process.exit(0)
  } else {
    process.exit(0)
  }
}

// Handle shutdown signals
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.fatal({ error }, 'Uncaught exception')
  process.exit(1)
})

process.on('unhandledRejection', (reason, promise) => {
  logger.fatal({ reason, promise }, 'Unhandled rejection')
  process.exit(1)
})

// Start server only if not in test environment or if this file is run directly
if (process.env.NODE_ENV !== 'test' || require.main === module) {
  validateConfig()

  server.listen(config.port, config.host, () => {
    console.log(generateStartupBanner(config))
  })
}

// Export for testing
module.exports = { server, config, sessions, langfuse }

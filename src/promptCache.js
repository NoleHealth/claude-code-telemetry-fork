/**
 * Prompt Cache Module
 * 
 * Implements a two-tier caching system for Langfuse prompts:
 * - L1: In-memory cache for ultra-fast access
 * - L2: Redis cache for persistence and sharing across instances
 * 
 * Features:
 * - Automatic fallback from L1 -> L2 -> API
 * - Cache invalidation support
 * - Metrics tracking
 * - TTL-based expiration
 */

const { createClient } = require('redis')
const pino = require('pino')

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
})

class PromptCache {
  constructor(langfuseClient, config = {}) {
    this.langfuse = langfuseClient
    
    // L1: In-memory cache configuration
    this.l1Cache = new Map()
    this.l1TTL = config.l1TTL || 300000 // 5 minutes default
    
    // L2: Redis cache configuration
    this.l2TTL = config.l2TTL || 3600 // 1 hour in seconds
    this.redisUrl = config.redisUrl || process.env.REDIS_URL || 'redis://localhost:6379'
    
    // Metrics tracking
    this.metrics = {
      hits: { l1: 0, l2: 0 },
      misses: 0,
      fetches: 0,
      invalidations: 0,
      errors: 0,
    }
    
    // Initialize Redis client
    this.initRedis()
  }
  
  async initRedis() {
    try {
      this.redisClient = createClient({
        url: this.redisUrl,
      })
      
      this.redisClient.on('error', (err) => {
        logger.error({ error: err }, 'Redis client error')
        this.metrics.errors++
      })
      
      await this.redisClient.connect()
      logger.info('Redis client connected for prompt cache')
    } catch (error) {
      logger.error({ error }, 'Failed to connect to Redis')
      this.redisClient = null
    }
  }
  
  /**
   * Get a prompt from cache or fetch from Langfuse
   * @param {string} promptName - Name of the prompt to fetch
   * @returns {Object|null} Prompt metadata or null if not found
   */
  async getPrompt(promptName) {
    if (!promptName) return null
    
    // Check L1 cache
    const l1Hit = this.l1Cache.get(promptName)
    if (l1Hit && (Date.now() - l1Hit.fetchedAt < this.l1TTL)) {
      logger.debug(`L1 cache hit: ${promptName}`)
      this.metrics.hits.l1++
      return l1Hit.data
    }
    
    // Check L2 Redis cache (if available)
    if (this.redisClient && this.redisClient.isOpen) {
      try {
        const l2Key = `langfuse:prompt:${promptName}`
        const l2Hit = await this.redisClient.get(l2Key)
        
        if (l2Hit) {
          logger.debug(`L2 cache hit: ${promptName}`)
          this.metrics.hits.l2++
          
          const data = JSON.parse(l2Hit)
          
          // Populate L1 from L2
          this.l1Cache.set(promptName, {
            fetchedAt: Date.now(),
            data,
          })
          
          return data
        }
      } catch (error) {
        logger.error({ error, promptName }, 'Redis cache error')
        this.metrics.errors++
      }
    }
    
    // Cache miss - fetch from Langfuse
    logger.debug(`Cache miss, fetching from Langfuse: ${promptName}`)
    this.metrics.misses++
    
    try {
      const prompt = await this.langfuse.getPrompt(promptName, undefined, {
        cacheTtlSeconds: 0, // Disable Langfuse SDK cache since we have our own
      })
      
      this.metrics.fetches++
      
      const data = {
        name: promptName,
        version: prompt.version,
        labels: prompt.labels || [],
        type: prompt.type,
        fetchedAt: new Date().toISOString(),
      }
      
      // Update L1 cache
      this.l1Cache.set(promptName, {
        fetchedAt: Date.now(),
        data,
      })
      
      // Update L2 cache (if available)
      if (this.redisClient && this.redisClient.isOpen) {
        try {
          const l2Key = `langfuse:prompt:${promptName}`
          await this.redisClient.setEx(
            l2Key,
            this.l2TTL,
            JSON.stringify(data)
          )
          logger.debug(`Cached prompt in L2: ${promptName}`)
        } catch (error) {
          logger.error({ error, promptName }, 'Failed to cache in Redis')
          this.metrics.errors++
        }
      }
      
      return data
    } catch (error) {
      logger.error({ error, promptName }, 'Failed to fetch prompt from Langfuse')
      this.metrics.errors++
      return null
    }
  }
  
  /**
   * Invalidate a specific prompt from all caches
   * @param {string} promptName - Name of the prompt to invalidate
   */
  async invalidate(promptName) {
    // Clear from L1
    this.l1Cache.delete(promptName)
    
    // Clear from L2 (if available)
    if (this.redisClient && this.redisClient.isOpen) {
      try {
        await this.redisClient.del(`langfuse:prompt:${promptName}`)
      } catch (error) {
        logger.error({ error, promptName }, 'Failed to invalidate Redis cache')
        this.metrics.errors++
      }
    }
    
    this.metrics.invalidations++
    logger.info(`Invalidated prompt cache: ${promptName}`)
  }
  
  /**
   * Clear all prompts from all caches
   */
  async clear() {
    // Clear L1
    const l1Size = this.l1Cache.size
    this.l1Cache.clear()
    
    // Clear L2 (if available)
    let l2Size = 0
    if (this.redisClient && this.redisClient.isOpen) {
      try {
        const keys = await this.redisClient.keys('langfuse:prompt:*')
        l2Size = keys.length
        if (keys.length > 0) {
          await this.redisClient.del(keys)
        }
      } catch (error) {
        logger.error({ error }, 'Failed to clear Redis cache')
        this.metrics.errors++
      }
    }
    
    logger.info(`Cleared all prompt caches (L1: ${l1Size}, L2: ${l2Size})`)
  }
  
  /**
   * Get cache status and metrics
   * @returns {Object} Cache status information
   */
  async getStatus() {
    const l1Items = Array.from(this.l1Cache.entries()).map(([name, item]) => ({
      name,
      version: item.data.version,
      type: item.data.type,
      age: Math.floor((Date.now() - item.fetchedAt) / 1000),
      labels: item.data.labels,
    }))
    
    let l2Keys = []
    if (this.redisClient && this.redisClient.isOpen) {
      try {
        const keys = await this.redisClient.keys('langfuse:prompt:*')
        l2Keys = keys.map(k => k.replace('langfuse:prompt:', ''))
      } catch (error) {
        logger.error({ error }, 'Failed to get Redis keys')
      }
    }
    
    const hitRate = {
      l1: this.metrics.hits.l1 / (this.metrics.hits.l1 + this.metrics.hits.l2 + this.metrics.misses) || 0,
      l2: this.metrics.hits.l2 / (this.metrics.hits.l1 + this.metrics.hits.l2 + this.metrics.misses) || 0,
      overall: (this.metrics.hits.l1 + this.metrics.hits.l2) / 
               (this.metrics.hits.l1 + this.metrics.hits.l2 + this.metrics.misses) || 0,
    }
    
    return {
      l1: {
        size: this.l1Cache.size,
        ttl: this.l1TTL / 1000,
        items: l1Items,
      },
      l2: {
        connected: this.redisClient && this.redisClient.isOpen,
        size: l2Keys.length,
        ttl: this.l2TTL,
        keys: l2Keys,
      },
      metrics: {
        ...this.metrics,
        hitRate,
      },
      config: {
        l1TTL: `${this.l1TTL / 1000}s`,
        l2TTL: `${this.l2TTL}s`,
        redisUrl: this.redisUrl.replace(/:[^:@]+@/, ':***@'), // Hide password
      },
    }
  }
  
  /**
   * Preload prompts from Langfuse (optional startup optimization)
   * @param {string} label - Label to filter prompts (default: 'production')
   */
  async preloadPrompts(label = 'production') {
    try {
      logger.info(`Preloading prompts with label: ${label}`)
      
      const response = await this.langfuse.api.promptsList({
        label,
        limit: 100,
      })
      
      const prompts = response.data || []
      let loaded = 0
      
      for (const prompt of prompts) {
        await this.getPrompt(prompt.name)
        loaded++
      }
      
      logger.info(`Preloaded ${loaded} prompts into cache`)
      return loaded
    } catch (error) {
      logger.error({ error }, 'Failed to preload prompts')
      return 0
    }
  }
  
  /**
   * Cleanup resources on shutdown
   */
  async shutdown() {
    if (this.redisClient) {
      await this.redisClient.quit()
      logger.info('Redis client disconnected')
    }
  }
}

module.exports = { PromptCache }
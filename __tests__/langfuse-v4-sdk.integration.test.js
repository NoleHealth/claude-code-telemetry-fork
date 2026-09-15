/**
 * Langfuse v4 SDK Migration - Regression Test
 *
 * The v3 -> v4/v5 JS SDK migration (@langfuse/client, @langfuse/tracing, @langfuse/otel)
 * changed how traces/generations/events/scores are created and shipped. Three specific
 * things silently broke or mis-recorded data during that migration and are the highest
 * regression risk if the SDK is touched again:
 *
 *  1. Trace-level sessionId/userId: this deployment's Langfuse v4 server (`legacy` write
 *     mode) only promotes sessionId/userId from the legacy `langfuse.user.id` /
 *     `langfuse.session.id` span attributes, not the SDK's new unprefixed `user.id` /
 *     `session.id` convention alone - see setTraceIdentity() in src/sessionHandler.js.
 *  2. Generation token usage: the server only honors `usageDetails`, not the legacy
 *     `usage` field alone - passing only `usage` silently falls back to auto-estimated
 *     (wrong) token counts.
 *  3. Score/session-summary flush: `LangfuseSpanProcessor`'s `flushInterval` option is in
 *     seconds, while this deployment's `LANGFUSE_FLUSH_INTERVAL` env var (kept for
 *     backward compatibility with the old SDK) is in milliseconds - an unconverted value
 *     effectively disables the periodic auto-flush.
 *
 * This test drives a full session through the real server and asserts on all three
 * against the live local Langfuse instance.
 */

const { LangfuseTestClient } = require('../test/helpers/langfuse-client')
const {
  generateTestSessionId,
  createUserPromptLog,
  createApiRequestLog,
  createOTLPLogsRequest,
} = require('../test/helpers/otlp-test-data')
const { startTestServer, stopTestServer } = require('../test/testServer')

describe('Langfuse v4 SDK migration', () => {
  let serverProcess
  let serverUrl
  let langfuseClient

  beforeAll(async () => {
    if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) {
      console.log('Skipping Langfuse v4 SDK migration test - no credentials provided')
      return
    }

    const serverInstance = await startTestServer('langfuse-v4-sdk.integration.test.js', {
      LANGFUSE_PUBLIC_KEY: process.env.LANGFUSE_PUBLIC_KEY,
      LANGFUSE_SECRET_KEY: process.env.LANGFUSE_SECRET_KEY,
      LANGFUSE_HOST: process.env.LANGFUSE_HOST || 'http://localhost:3000',
      // Exercises the ms->s conversion in src/server.js with a short interval so the
      // test doesn't have to wait out a full default flush cycle.
      LANGFUSE_FLUSH_INTERVAL: '2000',
    })
    serverProcess = serverInstance.serverProcess
    serverUrl = serverInstance.baseUrl

    langfuseClient = new LangfuseTestClient()
  })

  afterAll(async () => {
    if (serverProcess) {
      await stopTestServer(serverProcess)
    }
  })

  test('session identity, generation usage/cost, and scores survive the OTel span pipeline end-to-end', async () => {
    if (!langfuseClient) return

    const sessionId = generateTestSessionId()

    const promptLog = createUserPromptLog(sessionId, 'Explain the halting problem')
    const apiLog = createApiRequestLog(sessionId, {
      model: 'claude-3-opus-20240229',
      inputTokens: 120,
      outputTokens: 340,
      cacheReadTokens: 60,
      cost: 0.021,
    })

    const logsResponse = await fetch(`${serverUrl}/v1/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createOTLPLogsRequest([promptLog, apiLog])),
    })
    expect(logsResponse.status).toBe(200)

    const conversationTrace = await langfuseClient.waitForTrace({
      name: 'conversation-',
      sessionId,
    })

    // Regression 1: sessionId/userId must be populated on the trace, not null - this is
    // the legacy vs unprefixed span-attribute compat gap.
    expect(conversationTrace.sessionId).toBe(sessionId)
    expect(conversationTrace.userId).toBeTruthy()

    const fullTrace = await langfuseClient.getTrace(conversationTrace.id)
    const generation = (fullTrace.observations || []).find((o) => o.type === 'GENERATION')
    expect(generation).toBeDefined()

    // Regression 2: usageDetails must drive real token counts, not an auto-estimated
    // fallback derived from the (short, placeholder) input/output text.
    expect(generation.usage).toMatchObject({
      input: 120,
      output: 340,
      total: 460,
      unit: 'TOKENS',
    })
    expect(generation.calculatedTotalCost).toBeGreaterThan(0)

    // Trigger session finalize (creates the session-summary trace + quality/efficiency
    // scores) by shutting the server down gracefully, then wait for the flush.
    await stopTestServer(serverProcess)
    serverProcess = null

    // This deployment's `legacy` write mode ingests asynchronously (observed up to
    // ~20-30s lag under load) - poll rather than check once.
    const summaryTrace = await langfuseClient.waitForTrace({
      name: 'session-summary',
      sessionId,
    }, { timeout: 45000 })
    expect(summaryTrace.sessionId).toBe(sessionId)

    // Regression 3: scores are only visible if the OTel span processor's flush interval
    // was correctly converted from this deployment's millisecond config to the SDK's
    // expected seconds - an unconverted value would leave this empty for ~hours. Scores
    // have also been observed to land a few seconds after the trace itself becomes
    // queryable, so poll rather than check once.
    const deadline = Date.now() + 30000
    let scoreNames = []
    while (Date.now() < deadline) {
      const fullSummaryTrace = await langfuseClient.getTrace(summaryTrace.id)
      scoreNames = (fullSummaryTrace.scores || []).map((s) => s.name)
      if (scoreNames.includes('quality') && scoreNames.includes('efficiency')) break
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    expect(scoreNames).toEqual(expect.arrayContaining(['quality', 'efficiency']))
  }, 90000)
})

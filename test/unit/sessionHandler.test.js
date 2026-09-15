// Mock dependencies before requiring the module
jest.mock('pino', () => () => ({
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}))

// `mockStartObservation` (not a plain outer const) so Jest's module-factory hoisting
// allows referencing it inside jest.mock() below.
const mockStartObservation = jest.fn()
jest.mock('@langfuse/tracing', () => ({
  startObservation: (...args) => mockStartObservation(...args),
}))

// Now require the module after mocks are set up
const { SessionHandler, extractAttributesArray } = require('../../src/sessionHandler')

let observationCounter = 0

/**
 * Builds a fake Langfuse v5 observation (span/generation/event) matching the shape
 * SessionHandler expects: .id, .traceId, .otelSpan.{spanContext,setAttribute}, .update(), .end()
 */
function createMockObservation(name = 'observation') {
  observationCounter += 1
  const id = `${name}-id-${observationCounter}`
  const traceId = `${name}-trace-${observationCounter}`
  const spanContext = { traceId, spanId: id }
  return {
    id,
    traceId,
    otelSpan: {
      spanContext: () => spanContext,
      setAttribute: jest.fn(),
    },
    update: jest.fn(),
    end: jest.fn(),
  }
}

describe('SessionHandler', () => {
  let session
  let mockLangfuseServices

  beforeEach(() => {
    jest.clearAllMocks()
    observationCounter = 0
    mockStartObservation.mockImplementation((name) => createMockObservation(name))

    // Bundle SessionHandler expects at this.langfuse: `client` for score/prompt REST
    // calls, `spanProcessor` for flush/shutdown.
    mockLangfuseServices = {
      client: {
        score: { create: jest.fn() },
        flush: jest.fn(() => Promise.resolve()),
      },
      spanProcessor: {
        forceFlush: jest.fn(() => Promise.resolve()),
      },
    }

    session = new SessionHandler('test-session-id', {
      'service.name': 'test-service',
      'service.version': '1.0.0',
    }, mockLangfuseServices)
  })

  describe('constructor', () => {
    test('initializes with correct properties', () => {
      expect(session.sessionId).toBe('test-session-id')
      expect(session.langfuse).toBe(mockLangfuseServices)
      expect(session.totalCost).toBe(0)
      expect(session.totalTokens).toBe(0)
      expect(session.linesAdded).toBe(0)
      expect(session.linesRemoved).toBe(0)
      expect(session.metadata.service.name).toBe('test-service')
      expect(session.metadata.service.version).toBe('1.0.0')
    })

    test('throws error if sessionId is not provided', () => {
      expect(() => new SessionHandler(null, {}, mockLangfuseServices)).toThrow('SessionHandler requires a sessionId')
    })
  })

  describe('createEvent', () => {
    test('returns null and does not call startObservation when there is no current trace', () => {
      session.currentTrace = null
      const result = session.createEvent({ name: 'no-trace-event' })
      expect(result).toBeNull()
      expect(mockStartObservation).not.toHaveBeenCalled()
    })

    test('nests under the current trace by default', () => {
      session.currentTrace = createMockObservation('trace')
      session.createEvent({ name: 'my-event', input: { a: 1 }, level: 'DEFAULT' })

      expect(mockStartObservation).toHaveBeenCalledWith(
        'my-event',
        expect.objectContaining({ input: { a: 1 }, level: 'DEFAULT' }),
        expect.objectContaining({
          asType: 'event',
          parentSpanContext: session.currentTrace.otelSpan.spanContext(),
        }),
      )
    })

    test('nests under an explicit parent when given', () => {
      session.currentTrace = createMockObservation('trace')
      const parent = createMockObservation('generation')
      session.createEvent({ name: 'nested-event', parent })

      expect(mockStartObservation).toHaveBeenCalledWith(
        'nested-event',
        expect.any(Object),
        expect.objectContaining({ parentSpanContext: parent.otelSpan.spanContext() }),
      )
    })
  })

  describe('processMetric', () => {
    test('processes cost usage metrics', () => {
      const metric = { name: 'claude_code.cost.usage' }
      const dataPoint = { asDouble: 0.25 }
      const attrs = { model: 'claude-3-opus' }

      session.processMetric(metric, dataPoint, attrs)

      expect(session.totalCost).toBe(0.25) // Cost is now tracked from metrics
    })

    test('processes token usage metrics', () => {
      const metric = { name: 'claude_code.token.usage' }
      const dataPoint = { asDouble: 1500 }
      const attrs = { type: 'input', model: 'claude-3-opus' }

      session.processMetric(metric, dataPoint, attrs)

      expect(session.totalTokens).toBe(1500) // Tokens are now tracked from metrics
    })

    test('processes lines of code metrics', () => {
      session.currentTrace = createMockObservation('trace')

      const metric = { name: 'claude_code.lines_of_code.count' }
      const dataPoint = { asDouble: 42 }
      const attrs = { type: 'added' }

      session.processMetric(metric, dataPoint, attrs)

      expect(session.linesAdded).toBe(42)
      expect(session.linesRemoved).toBe(0)
      expect(mockStartObservation).toHaveBeenCalledWith(
        'code-modification',
        expect.objectContaining({
          metadata: expect.objectContaining({ lines: 42, type: 'added' }),
          level: 'DEFAULT',
        }),
        expect.objectContaining({ asType: 'event' }),
      )
    })

    test('processes lines removed metrics', () => {
      session.currentTrace = createMockObservation('trace')

      const metric = { name: 'claude_code.lines_of_code.count' }
      const dataPoint = { asDouble: 10 }
      const attrs = { type: 'removed' }

      session.processMetric(metric, dataPoint, attrs)

      expect(session.linesAdded).toBe(0)
      expect(session.linesRemoved).toBe(10)
    })

    test('processes session count metrics', () => {
      session.currentTrace = createMockObservation('trace')

      const metric = { name: 'claude_code.session.count' }
      const dataPoint = { asInt: 1 }
      const attrs = {}

      session.processMetric(metric, dataPoint, attrs)

      expect(mockStartObservation).toHaveBeenCalledWith(
        'session-started',
        expect.objectContaining({ metadata: expect.objectContaining({ count: 1 }) }),
        expect.objectContaining({ asType: 'event' }),
      )
    })

    test('processes pull request count metrics', () => {
      session.currentTrace = createMockObservation('trace')

      const metric = { name: 'claude_code.pull_request.count' }
      const dataPoint = { asDouble: 1 }
      const attrs = {}

      session.processMetric(metric, dataPoint, attrs)

      expect(mockStartObservation).toHaveBeenCalledWith(
        'pull-request-created',
        expect.objectContaining({ metadata: expect.objectContaining({ count: 1 }) }),
        expect.objectContaining({ asType: 'event' }),
      )
    })

    test('processes commit count metrics', () => {
      session.currentTrace = createMockObservation('trace')

      const metric = { name: 'claude_code.commit.count' }
      const dataPoint = { asInt: 2 }
      const attrs = {}

      session.processMetric(metric, dataPoint, attrs)

      expect(mockStartObservation).toHaveBeenCalledWith(
        'git-commit-created',
        expect.objectContaining({ metadata: expect.objectContaining({ count: 2 }) }),
        expect.objectContaining({ asType: 'event' }),
      )
    })

    test('processes code edit tool decision metrics', () => {
      session.currentTrace = createMockObservation('trace')

      const metric = { name: 'claude_code.code_edit_tool.decision' }
      const dataPoint = {}
      const attrs = {
        decision: 'accept',
        tool: 'Write',
        language: 'javascript',
      }

      session.processMetric(metric, dataPoint, attrs)

      expect(mockStartObservation).toHaveBeenCalledWith(
        'tool-permission-decision',
        expect.objectContaining({
          metadata: expect.objectContaining({ tool: 'Write', decision: 'accept', language: 'javascript' }),
        }),
        expect.objectContaining({ asType: 'event' }),
      )
    })

    test('processes active time total metrics', () => {
      session.currentTrace = createMockObservation('trace')

      const metric = { name: 'claude_code.active_time.total' }
      const dataPoint = { asDouble: 300.5 }
      const attrs = {}

      session.processMetric(metric, dataPoint, attrs)

      expect(mockStartObservation).toHaveBeenCalledWith(
        'active-time-update',
        expect.objectContaining({ metadata: expect.objectContaining({ seconds: 300.5 }) }),
        expect.objectContaining({ asType: 'event' }),
      )
    })

    test('handles unknown metrics gracefully', () => {
      const metric = { name: 'claude_code.unknown.metric' }
      const dataPoint = { asDouble: 123 }
      const attrs = { foo: 'bar' }

      // Should not throw
      expect(() => {
        session.processMetric(metric, dataPoint, attrs)
      }).not.toThrow()
    })
  })

  describe('handleApiError', () => {
    test('logs API errors and creates events', () => {
      session.currentTrace = createMockObservation('trace')

      const attrs = {
        model: 'claude-3-opus',
        error_message: 'Rate limit exceeded',
        status_code: 429,
      }
      const timestamp = '2024-07-31T10:00:00Z'

      session.handleApiError(attrs, timestamp)

      expect(mockStartObservation).toHaveBeenCalledWith(
        'api-error',
        expect.objectContaining({
          metadata: {
            model: 'claude-3-opus',
            error: 'Rate limit exceeded',
            statusCode: 429,
            timestamp: '2024-07-31T10:00:00Z',
          },
          level: 'ERROR',
        }),
        expect.objectContaining({ asType: 'event' }),
      )
    })

    test('handles missing error message', () => {
      session.currentTrace = createMockObservation('trace')

      const attrs = {
        model: 'claude-3-opus',
        status: 500,
      }
      const timestamp = '2024-07-31T10:00:00Z'

      session.handleApiError(attrs, timestamp)

      expect(mockStartObservation).toHaveBeenCalledWith(
        'api-error',
        expect.objectContaining({
          metadata: expect.objectContaining({
            error: 'Unknown error',
            statusCode: 500,
          }),
        }),
        expect.any(Object),
      )
    })

    test('handles API errors without current trace', () => {
      session.currentTrace = null

      const attrs = {
        error: 'Network error',
      }

      // Should not throw
      expect(() => {
        session.handleApiError(attrs, '2024-07-31T10:00:00Z')
      }).not.toThrow()
      expect(mockStartObservation).not.toHaveBeenCalled()
    })
  })

  describe('handleUserPrompt', () => {
    test('creates a new trace for conversation', async () => {
      const attrs = {
        prompt: 'Hello, Claude!',
        prompt_length: 14,
        'user.email': 'test@example.com',
      }
      const timestamp = '2024-07-31T10:00:00Z'

      await session.handleUserPrompt(attrs, timestamp)

      expect(session.conversationCount).toBe(1)
      expect(mockStartObservation).toHaveBeenCalledWith(
        'conversation-1',
        expect.objectContaining({
          input: {
            prompt: 'Hello, Claude!',
            length: 14,
          },
          metadata: expect.objectContaining({
            conversationIndex: 1,
          }),
          version: '1.0.0',
        }),
      )

      // sessionId/userId are set directly on the OTel span, not passed to
      // startObservation - see setTraceIdentity() in sessionHandler.js.
      expect(session.currentTrace.otelSpan.setAttribute).toHaveBeenCalledWith('user.id', 'test@example.com')
      expect(session.currentTrace.otelSpan.setAttribute).toHaveBeenCalledWith('langfuse.user.id', 'test@example.com')
      expect(session.currentTrace.otelSpan.setAttribute).toHaveBeenCalledWith('session.id', 'test-session-id')
      expect(session.currentTrace.otelSpan.setAttribute).toHaveBeenCalledWith('langfuse.session.id', 'test-session-id')

      // Ended immediately so it's visible in Langfuse right away rather than staying
      // "in flight" for the whole conversation - see sessionHandler.js.
      expect(session.currentTrace.end).toHaveBeenCalled()
    })

    test('starting a new conversation does not touch the previous (already-ended) trace', async () => {
      await session.handleUserPrompt({ prompt: 'first' }, '2024-07-31T10:00:00Z')
      const firstTrace = session.currentTrace
      firstTrace.end.mockClear()

      await session.handleUserPrompt({ prompt: 'second' }, '2024-07-31T10:00:01Z')

      expect(firstTrace.end).not.toHaveBeenCalled()
      expect(session.currentTrace).not.toBe(firstTrace)
    })
  })

  describe('handleApiRequest', () => {
    test('creates generation span for API requests', () => {
      session.currentTrace = createMockObservation('trace')

      const attrs = {
        model: 'claude-3-opus',
        input_tokens: 100,
        output_tokens: 200,
        cost: 0.05,
        cache_read_tokens: 50,
        'api.response_time': 1000,
      }
      const timestamp = '2024-07-31T10:00:00Z'

      session.handleApiRequest(attrs, timestamp)

      expect(session.totalCost).toBe(0.05)
      expect(session.totalTokens).toBe(300)
      expect(session.apiCallCount).toBe(1)
      expect(mockStartObservation).toHaveBeenCalledWith(
        'generation-claude-3-opus',
        expect.objectContaining({
          model: 'claude-3-opus',
          usage: { input: 100, output: 200, total: 300, unit: 'TOKENS' },
          usageDetails: { input: 100, output: 200, total: 300 },
        }),
        expect.objectContaining({ asType: 'generation' }),
      )
    })

    test('ends the generation immediately (cannot be updated again later)', () => {
      session.currentTrace = createMockObservation('trace')

      session.handleApiRequest({ model: 'claude-3-opus', input_tokens: 1, output_tokens: 1 }, '2024-07-31T10:00:00Z')

      expect(session.currentSpan.end).toHaveBeenCalled()
    })

    test('routing (haiku) generations are not tracked as currentSpan', () => {
      session.currentTrace = createMockObservation('trace')

      session.handleApiRequest({ model: 'claude-3-5-haiku', input_tokens: 1, output_tokens: 1 }, '2024-07-31T10:00:00Z')

      expect(session.currentSpan).toBeNull()
    })

    test('creates its own trace when no user prompt preceded it', () => {
      session.currentTrace = null

      session.handleApiRequest({ model: 'claude-3-opus', input_tokens: 1, output_tokens: 1 }, '2024-07-31T10:00:00Z')

      expect(session.currentTrace).not.toBeNull()
      expect(mockStartObservation).toHaveBeenCalledWith(
        'conversation-1',
        expect.objectContaining({ input: expect.objectContaining({ firstApiCall: true }) }),
      )
      expect(session.currentTrace.end).toHaveBeenCalled()
    })
  })

  describe('handleToolResult', () => {
    beforeEach(() => {
      session.currentTrace = createMockObservation('trace')
    })

    test('extracts tool_name correctly', () => {
      const attrs = {
        tool_name: 'Bash',
        success: 'true',
        duration_ms: '150',
      }
      const timestamp = '2024-07-31T10:00:00Z'

      session.handleToolResult(attrs, timestamp)

      expect(session.toolCallCount).toBe(1)
      expect(session.toolSequence).toHaveLength(1)
      expect(session.toolSequence[0]).toEqual({
        name: 'Bash',
        success: true,
        duration: 150,
        timestamp: '2024-07-31T10:00:00Z',
      })
      expect(mockStartObservation).toHaveBeenCalledWith(
        'tool-Bash',
        expect.objectContaining({
          input: expect.objectContaining({ toolName: 'Bash' }),
        }),
        expect.objectContaining({ asType: 'event' }),
      )
    })

    test('falls back to "unknown" when tool_name is missing', () => {
      const attrs = {
        success: 'true',
        duration_ms: '100',
      }
      const timestamp = '2024-07-31T10:00:00Z'

      session.handleToolResult(attrs, timestamp)

      expect(session.toolSequence[0].name).toBe('unknown')
      expect(mockStartObservation).toHaveBeenCalledWith(
        'tool-unknown',
        expect.objectContaining({
          input: expect.objectContaining({ toolName: 'unknown' }),
        }),
        expect.any(Object),
      )
    })

    test('handles legacy tool attribute name', () => {
      const attrs = {
        tool: 'Write', // Legacy attribute name
        success: 'true',
        duration_ms: '200',
      }
      const timestamp = '2024-07-31T10:00:00Z'

      session.handleToolResult(attrs, timestamp)

      expect(session.toolSequence[0].name).toBe('Write')
    })

    test('extracts duration_ms correctly', () => {
      const attrs = {
        tool_name: 'Edit',
        success: 'true',
        duration_ms: '250',
      }
      const timestamp = '2024-07-31T10:00:00Z'

      session.handleToolResult(attrs, timestamp)

      expect(session.toolSequence[0].duration).toBe(250)
      expect(mockStartObservation).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          output: expect.objectContaining({ durationMs: 250 }),
        }),
        expect.any(Object),
      )
    })

    test('handles missing duration_ms', () => {
      const attrs = {
        tool_name: 'Read',
        success: 'true',
        // duration_ms missing
      }
      const timestamp = '2024-07-31T10:00:00Z'

      session.handleToolResult(attrs, timestamp)

      expect(session.toolSequence[0].duration).toBe(0)
      expect(mockStartObservation).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          output: expect.objectContaining({ durationMs: 0 }),
        }),
        expect.any(Object),
      )
    })

    test('parses success correctly', () => {
      const attrsSuccess = {
        tool_name: 'Grep',
        success: 'true',
        duration_ms: '50',
      }

      session.handleToolResult(attrsSuccess, '2024-07-31T10:00:00Z')
      expect(session.toolSequence[0].success).toBe(true)

      // Test failure case
      const attrsFail = {
        tool_name: 'WebFetch',
        success: false,
        duration_ms: '100',
      }

      session.handleToolResult(attrsFail, '2024-07-31T10:00:01Z')
      expect(session.toolSequence[1].success).toBe(false)
    })

    test('increments tool call count', () => {
      const attrs = {
        tool_name: 'TodoWrite',
        success: 'true',
        duration_ms: '30',
      }

      session.handleToolResult(attrs, '2024-07-31T10:00:00Z')
      expect(session.toolCallCount).toBe(1)

      session.handleToolResult(attrs, '2024-07-31T10:00:01Z')
      expect(session.toolCallCount).toBe(2)
    })

    test('tracks consecutive tool calls in sequence', () => {
      // First tool in sequence
      session.handleToolResult({
        tool_name: 'Read',
        success: 'true',
        duration_ms: '100',
      }, '2024-07-31T10:00:00Z')

      // Second tool in sequence
      session.handleToolResult({
        tool_name: 'Edit',
        success: 'true',
        duration_ms: '200',
      }, '2024-07-31T10:00:01Z')

      expect(session.toolSequence).toHaveLength(2)
      expect(session.toolSequence[0].name).toBe('Read')
      expect(session.toolSequence[1].name).toBe('Edit')
      expect(session.toolSequence[0].duration).toBe(100)
      expect(session.toolSequence[1].duration).toBe(200)

      // Tool sequence is reported during session finalization
      expect(session.toolCallCount).toBe(2)
    })

    test('nests the tool event under the current generation when one exists', () => {
      const generation = createMockObservation('generation')
      session.currentSpan = generation

      session.handleToolResult({ tool_name: 'Read', success: 'true', duration_ms: '10' }, '2024-07-31T10:00:00Z')

      expect(mockStartObservation).toHaveBeenCalledWith(
        'tool-Read',
        expect.any(Object),
        expect.objectContaining({ parentSpanContext: generation.otelSpan.spanContext() }),
      )
    })
  })

  describe('processLogRecord', () => {
    test('processes user prompt event', () => {
      const logRecord = {
        body: { stringValue: 'claude_code.user_prompt' },
        timeUnixNano: Date.now() * 1000000,
        attributes: [
          { key: 'prompt', value: { stringValue: 'test prompt' } },
          { key: 'user.email', value: { stringValue: 'test@example.com' } },
        ],
      }

      const initialCount = session.conversationCount
      session.processLogRecord(logRecord, {})

      expect(session.conversationCount).toBe(initialCount + 1)
      expect(mockStartObservation).toHaveBeenCalled()
    })

    test('processes api request event', () => {
      const logRecord = {
        body: { stringValue: 'claude_code.api_request' },
        timeUnixNano: Date.now() * 1000000,
        attributes: [
          { key: 'model', value: { stringValue: 'claude-3-opus' } },
          { key: 'input_tokens', value: { stringValue: '100' } },
          { key: 'output_tokens', value: { stringValue: '200' } },
          { key: 'cost_usd', value: { stringValue: '0.1' } },
        ],
      }

      // Should not throw
      expect(() => session.processLogRecord(logRecord, {})).not.toThrow()
    })

    test('processes tool result event', () => {
      // First need to create a trace/span
      session.handleUserPrompt({ prompt: 'test' }, new Date().toISOString())

      const logRecord = {
        body: { stringValue: 'claude_code.tool_result' },
        timeUnixNano: Date.now() * 1000000,
        attributes: [
          { key: 'tool_name', value: { stringValue: 'Bash' } },
          { key: 'success', value: { stringValue: 'true' } },
        ],
      }

      // Should not throw
      expect(() => session.processLogRecord(logRecord, {})).not.toThrow()
    })

    test('processes api error event', () => {
      const logRecord = {
        body: { stringValue: 'claude_code.api_error' },
        timeUnixNano: Date.now() * 1000000,
        attributes: [
          { key: 'error_message', value: { stringValue: 'Rate limit' } },
          { key: 'status_code', value: { stringValue: '429' } },
        ],
      }

      // Should not throw
      expect(() => session.processLogRecord(logRecord, {})).not.toThrow()
    })

    test('ignores unknown event', () => {
      const logRecord = {
        body: { stringValue: 'unknown_event' },
        timeUnixNano: Date.now() * 1000000,
        attributes: [],
      }

      // Should not throw
      expect(() => session.processLogRecord(logRecord, {})).not.toThrow()
    })
  })

  describe('finalize', () => {
    test('calculates session metrics correctly', async () => {
      // Set up session data
      session.totalCost = 0.5
      session.totalTokens = 2000
      session.apiCallCount = 3
      session.toolCallCount = 5
      session.conversationCount = 2
      session.linesAdded = 100
      session.linesRemoved = 20

      await session.finalize()

      expect(mockStartObservation).toHaveBeenCalledWith(
        'session-summary',
        expect.objectContaining({
          version: '1.0.0',
          input: expect.objectContaining({
            sessionStart: expect.any(String),
            metadata: expect.objectContaining({
              service: {
                name: 'test-service',
                version: '1.0.0',
              },
            }),
          }),
          output: expect.objectContaining({
            conversationCount: 2,
            apiCallCount: 3,
            toolCallCount: 5,
            totalCost: 0.5,
            totalTokens: 2000,
            codeChanges: {
              linesAdded: 100,
              linesRemoved: 20,
              netChange: 80,
            },
          }),
          metadata: expect.any(Object),
        }),
      )

      expect(mockLangfuseServices.spanProcessor.forceFlush).toHaveBeenCalled()
      expect(mockLangfuseServices.client.flush).toHaveBeenCalled()
    })

    test('drops the current span reference without re-ending it', async () => {
      // currentSpan (a generation) is already ended by the time handleApiRequest
      // returns - see sessionHandler.js. finalize() must not call update()/end() on
      // it again, since Langfuse silently drops updates made after end().
      const mockSpan = createMockObservation('generation')
      mockSpan.end() // simulate it already being ended, as handleApiRequest leaves it
      mockSpan.end.mockClear()
      mockSpan.update.mockClear()
      session.currentSpan = mockSpan

      await session.finalize()

      expect(mockSpan.end).not.toHaveBeenCalled()
      expect(mockSpan.update).not.toHaveBeenCalled()
      expect(session.currentSpan).toBeNull()
    })

    test('drops the current trace reference without re-ending it, but still records conversation latency', async () => {
      // currentTrace is already ended when created in handleUserPrompt() - finalize()
      // must not call update()/end() on it again (silently dropped by Langfuse).
      const mockTrace = createMockObservation('trace')
      mockTrace.end()
      mockTrace.end.mockClear()
      mockTrace.update.mockClear()
      session.currentTrace = mockTrace
      session.conversationStartTime = Date.now() - 5000 // 5 seconds ago

      await session.finalize()

      expect(mockTrace.update).not.toHaveBeenCalled()
      expect(mockTrace.end).not.toHaveBeenCalled()
      expect(session.currentTrace).toBeNull()
      expect(session.latencies.conversation).toHaveLength(1)
      expect(session.latencies.conversation[0]).toBeGreaterThan(4000)
    })

    test('handles empty latency arrays', async () => {
      // Leave latency arrays empty
      session.latencies = {
        api: [],
        tool: [],
        conversation: [],
      }

      await session.finalize()

      const summaryCall = mockStartObservation.mock.calls.find(([name]) => name === 'session-summary')
      expect(summaryCall[1].output.performance.api).toBeNull()
      expect(summaryCall[1].output.performance.tool).toBeNull()
      expect(summaryCall[1].output.performance.conversation).toBeNull()
    })

    test('creates quality and efficiency scores against the session-summary trace', async () => {
      session.totalCost = 0.5
      session.totalTokens = 2000

      await session.finalize()

      const summaryTraceId = mockStartObservation.mock.results
        .map((r) => r.value)
        .find((v) => v.id.startsWith('session-summary'))?.traceId

      expect(mockLangfuseServices.client.score.create).toHaveBeenCalledWith(
        expect.objectContaining({ traceId: summaryTraceId, name: 'quality' }),
      )
      expect(mockLangfuseServices.client.score.create).toHaveBeenCalledWith(
        expect.objectContaining({ traceId: summaryTraceId, name: 'efficiency' }),
      )
    })

    test('handles errors during finalization', async () => {
      // Make the flush reject
      mockLangfuseServices.spanProcessor.forceFlush.mockRejectedValue(new Error('Network error'))

      session.totalCost = 0.5
      session.totalTokens = 1000

      // Should not throw
      await expect(session.finalize()).resolves.not.toThrow()

      // Should still attempt to create the trace
      expect(mockStartObservation).toHaveBeenCalledWith('session-summary', expect.any(Object))
    }, 15000)
  })
})

describe('Helper Functions', () => {
  describe('extractAttributesArray', () => {
    test('extracts string attributes', () => {
      const attributes = [
        { key: 'name', value: { stringValue: 'test' } },
      ]
      const result = extractAttributesArray(attributes)
      expect(result).toEqual({ name: 'test' })
    })

    test('extracts numeric attributes', () => {
      const attributes = [
        { key: 'count', value: { intValue: '42' } },
        { key: 'rate', value: { doubleValue: 3.14 } },
      ]
      const result = extractAttributesArray(attributes)
      expect(result).toEqual({ count: 42, rate: 3.14 })
    })

    test('handles null attributes', () => {
      const result = extractAttributesArray(null)
      expect(result).toEqual({})
    })

    test('extracts array attributes', () => {
      const attributes = [
        {
          key: 'items',
          value: {
            arrayValue: {
              values: [
                { stringValue: 'item1' },
                { stringValue: 'item2' },
              ],
            },
          },
        },
      ]

      const result = extractAttributesArray(attributes)
      expect(result).toEqual({ items: ['item1', 'item2'] })
    })

    test('extracts kvlist attributes', () => {
      const attributes = [
        {
          key: 'metadata',
          value: {
            kvlistValue: {
              values: [
                { key: 'name', value: { stringValue: 'test' } },
                { key: 'count', value: { intValue: '5' } },
              ],
            },
          },
        },
      ]

      const result = extractAttributesArray(attributes)
      expect(result).toEqual({
        metadata: {
          name: 'test',
          count: 5,
        },
      })
    })

    test('extracts boolean attributes', () => {
      const attributes = [
        { key: 'enabled', value: { boolValue: true } },
        { key: 'disabled', value: { boolValue: false } },
      ]

      const result = extractAttributesArray(attributes)
      expect(result).toEqual({ enabled: true, disabled: false })
    })

    test('handles unknown value types', () => {
      const attributes = [
        { key: 'unknown', value: { unknownType: 'value' } },
      ]

      const result = extractAttributesArray(attributes)
      expect(result).toEqual({ unknown: null })
    })
  })
})

/**
 * Jest setup file
 * Configures the test environment
 */

// Add custom Jest matchers if needed
expect.extend({
  toBeValidPort(received) {
    const pass = Number.isInteger(received) && received >= 1 && received <= 65535
    return {
      pass,
      message: () => pass
        ? `expected ${received} not to be a valid port`
        : `expected ${received} to be a valid port (1-65535)`,
    }
  },
})

// Suppress console output during tests unless debugging
if (process.env.DEBUG_TESTS !== 'true') {
  global.console = {
    ...console,
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  }
}

// Add skipIf helper for conditional test execution
global.describe.skipIf = (condition) => condition ? describe.skip : describe
global.test.skipIf = (condition) => condition ? test.skip : test

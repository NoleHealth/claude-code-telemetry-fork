module.exports = {
  testEnvironment: 'node',
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/**/*.test.js',
    '!src/server.js', // Tested via integration tests with spawned processes
  ],
  testMatch: [
    '**/test/**/*.test.js',
    '**/__tests__/**/*.test.js',
  ],
  // Jest doesn't honor `testTimeout` set inside `projects` entries when a project is
  // selected via --selectProjects (observed on jest 30.0.4) - set it here instead so
  // integration tests get enough headroom for this deployment's Langfuse `legacy` write
  // mode ingestion latency (observed up to ~20s). package.json's test:integration script
  // also passes --testTimeout=60000 explicitly as a second line of defense.
  testTimeout: 60000,
  setupFilesAfterEnv: ['<rootDir>/test/setup.js'],
  // Projects for different test types
  projects: [
    {
      displayName: 'unit',
      testMatch: [
        '<rootDir>/test/helpers.test.js',
        '<rootDir>/test/unit/**/*.test.js'
      ],
    },
    {
      displayName: 'integration',
      testMatch: [
        '<rootDir>/test/server.test.js',
        '<rootDir>/test/*.integration.test.js',
        '<rootDir>/test/integration/**/*.test.js',
        '<rootDir>/__tests__/**/*.test.js'
      ],
      maxWorkers: 1, // Run integration tests sequentially to avoid port conflicts
      testTimeout: 60000, // Longer timeout for real Langfuse calls
    },
  ],
  // Coverage thresholds
  // Note: Branch and function coverage are slightly lower because server.js
  // can't be unit tested (it's tested via integration tests with spawned processes)
  // All extracted business logic modules have >85% coverage
  coverageThreshold: {
    global: {
      branches: 76,      // Close to 80%, limited by conditional branches
      functions: 86,     // Achieved 86.27%
      lines: 94,         // Achieved 94.36%
      statements: 93,    // Achieved 93.29%
    },
  },
}
import { defineConfig } from 'vitest/config';

// Integration tests that drive OCR, local models, Godot or a browser and assert time budgets:
// they run after the rest, one file at a time, so they do not compete with each other for the CPU.
const HEAVY = [
  'packages/*/test/**/*.integration.test.ts',
  'packages/perception/test/candy-knight.test.ts',
  'packages/cli/test/export.test.ts',
];

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts'],
          exclude: HEAVY,
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'heavy',
          include: HEAVY,
          sequence: { groupOrder: 1 },
          maxWorkers: 1,
        },
      },
    ],
  },
});

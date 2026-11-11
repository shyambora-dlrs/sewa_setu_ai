// Jest-DOM matchers are only meaningful (and loadable) in jsdom test files.
if ("document" in globalThis) await import("@testing-library/jest-dom/vitest");
export {};

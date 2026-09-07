# Testing

Vitest. Tests live in `packages/<name>/test/` and end in `.test.ts`.

A test that cannot fail is not a test. When you write a guard around something
important, prove it: break the thing on purpose, watch the right test go red and
the others stay green, then revert. Especially for manifest and config tests,
where a typo in the assertion passes forever without ever checking anything.

Silence from a linter looks the same as a linter that scanned nothing. If a tool
reports no findings on a fresh setup, verify it is actually reading your files
before you trust it.

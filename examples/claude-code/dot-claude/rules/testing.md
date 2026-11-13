---
paths:
  - "**/*.test.ts"
  - "**/*.test.tsx"
---

# Test conventions

These load only when Claude reads or edits a test file, wherever it sits. A CLAUDE.md in one folder could not do that,
because the test files are spread through the codebase.

- One `describe` block per exported function; name each test after the behaviour, not the implementation.
- Use the fixtures in `test/fixtures/` rather than building objects by hand.
- Cover the edge cases: empty input, null, the largest allowed value, and an error from each dependency.
- Do not add a test that repeats a scenario an existing test already covers; read the file first.
- Run `npm test -- <file>` after every change to a test file.

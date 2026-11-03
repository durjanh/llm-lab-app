# Project: payments-api

## Commands
- Run `npm test` before committing
- Lint with `npm run lint`
- Start the local server with `npm run dev`

## Layout
- API handlers live in `src/api/handlers/`
- Shared errors live in `src/lib/errors.ts`

## Conventions
- Use 2-space indentation
- Throw `AppError` from `src/lib/errors.ts`, never a raw `Error`
- Every new endpoint needs a test in `tests/api/`

@docs/git-workflow.md

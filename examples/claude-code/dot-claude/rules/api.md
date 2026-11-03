---
paths:
  - "src/api/**/*.ts"
---

# API handler rules

- Validate every request body with the schemas in `src/api/schemas/`.
- Return errors through `AppError`, with an HTTP status and a stable error code.
- Never log request bodies; they can contain personal data.

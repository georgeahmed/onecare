Error Handling (HTTP)

Error Envelope (recommendation)
{
  "error": {
    "code": "string",        // machine-readable code
    "message": "string",     // human-friendly message (no internals)
    "details": { ... },       // optional structured fields
    "correlationId": "..."   // for tracing issues
  }
}

Guidelines
- Never return stack traces; log details server-side with correlationId.
- 4xx for client errors (validation, auth); 5xx for server-side failures.
- Validate bodies at the edge; return useful, safe messages.


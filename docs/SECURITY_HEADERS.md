# Security Headers & CSP Baseline

This baseline applies to every HTTP surface (backend APIs, portal, and reverse proxies). Adopt it unchanged unless a service has a documented exception.

## Default Policy

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data:;
  connect-src 'self' https://api.onecare.local;
  font-src 'self';
  frame-ancestors 'none';
  form-action 'self';
  base-uri 'self';
  upgrade-insecure-requests;
  report-uri https://reporting.onecare.local/csp
```

Start in **Report-Only** mode while onboarding new origins. Extend `script-src` for trusted CDNs, but require nonces or SRI hashes instead of `unsafe-inline`.

### Additional Headers

| Header | Value | Purpose |
|--------|-------|---------|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains; preload` | Enforce HTTPS everywhere. |
| `X-Content-Type-Options` | `nosniff` | Blocks MIME confusion. |
| `X-Frame-Options` | `DENY` | Clickjacking protection (redundant with CSP but cheap). |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Minimises data leaked via referrer headers. |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), interest-cohort=()` | Disable unused browser capabilities. |
| `Cross-Origin-Embedder-Policy` | `require-corp` | Tightens cross-origin resource loading for portal. |
| `Cross-Origin-Opener-Policy` | `same-origin` | Prevents cross-origin window interference. |

## Implementation Examples

### NGINX

```nginx
add_header Content-Security-Policy "$csp_policy" always;
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "DENY" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), interest-cohort=()" always;
add_header Cross-Origin-Embedder-Policy "require-corp" always;
add_header Cross-Origin-Opener-Policy "same-origin" always;
```

Define `$csp_policy` as an NGINX map so environments can loosen rules temporarily.

### FastAPI / Starlette

```python
from starlette.middleware.base import BaseHTTPMiddleware

SECURITY_HEADERS = {
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Opener-Policy": "same-origin",
}

class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        response = await call_next(request)
        for header, value in SECURITY_HEADERS.items():
            response.headers.setdefault(header, value)
        response.headers.setdefault("Content-Security-Policy", build_csp(request))
        return response
```

`build_csp` should return the correct policy (e.g., extend `connect-src` for staging APIs).

## Rollout Checklist

1. Enable Report-Only CSP and monitor violations via `report-uri`.
2. Update portal/service documentation with any required hostname allowlists.
3. Switch to enforced mode once dashboards show zero unexpected violations.
4. Review headers at least quarterly or when introducing new third-party content.

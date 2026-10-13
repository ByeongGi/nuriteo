# REG-001 actual fixture

Runs TLS PostgreSQL and a private-CA npm-compatible endpoint with separate
default and scoped base paths. It validates encrypted token use, exact scope
routing, custom CA, SSRF and redirect denial, integrity-preserving bounded
metadata, and the absence of fallback after a mapped Registry returns 404.

# SAVE-013 authenticated upload relay fixture

`run.sh` starts pinned PostgreSQL and private custom-CA HTTPS RustFS, then
executes the ignored SAVE-013 HTTP vertical test. It proves authenticated
single and multipart relay uploads, pre-body fail-closed checks, completion,
same-origin verified download, and absence of bearer URLs, object keys, or
storage credentials from relay projections.

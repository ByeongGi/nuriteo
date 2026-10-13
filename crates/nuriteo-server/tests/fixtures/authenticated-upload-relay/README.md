# SAVE-013 authenticated upload relay fixture

`run.sh` starts pinned PostgreSQL and private custom-CA HTTPS RustFS, then
executes the ignored SAVE-013 HTTP vertical test. It proves authenticated
single and multipart relay uploads, including a 16 MiB multipart part sent
through a real Hyper server, pre-body fail-closed checks, completion,
same-origin verified download, and absence of bearer URLs, object keys, or
storage credentials from relay projections. The large request exercises the
production HTTP path; the reader advances Hyper-owned frames without copying
them into an application replay buffer and exposes at most 64 KiB per read.

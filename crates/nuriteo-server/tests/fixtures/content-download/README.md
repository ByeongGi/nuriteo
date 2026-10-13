# SAVE-010 authorized content fixture

Runs the Project Working Head descriptor and same-origin bounded download stream
against custom-CA PostgreSQL and HTTPS RustFS. It covers Personal owner,
Organization owner/direct Read, revoked access after descriptor issuance, stale
Working Head, archive/delete fail-close, checksum/size metadata, unsupported
Range rejection, partial-read cancellation, and credential/object-key redaction.

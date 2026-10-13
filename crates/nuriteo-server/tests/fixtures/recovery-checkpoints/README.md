# SAVE-007 Recovery Checkpoints fixture

Runs the atomic Working Head journey against pinned custom-CA PostgreSQL and
HTTPS RustFS. The journey performs five distinct saves, retains exactly the
three newest replaced Heads, evicts only the oldest checkpoint on the fourth
replacement, verifies concurrent/idempotent commit convergence, and proves a
retained checkpoint blocks a GC `running` transition.

Run `./run.sh`; no host PostgreSQL or object store is used.

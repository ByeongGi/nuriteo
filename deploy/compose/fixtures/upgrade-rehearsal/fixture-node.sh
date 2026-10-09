#!/bin/sh
# The production Web image supplies Node. This fixture-only adapter implements
# the single `node -e <readiness probe>` boundary used by the helper.
exec wget -q -O /dev/null http://127.0.0.1:3000/sign-in

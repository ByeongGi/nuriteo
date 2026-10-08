#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

control_dir="${NURITEO_BETA_GATE_PROVIDER_TLS_DIR:?set NURITEO_BETA_GATE_PROVIDER_TLS_DIR}/control"
mkdir -p "$control_dir"

key_json() {
  local key="$1" kid="$2" modulus_hex modulus
  modulus_hex="$(openssl rsa -in "$key" -noout -modulus | cut -d= -f2)"
  modulus="$(python3 -c 'import base64,sys; print(base64.urlsafe_b64encode(bytes.fromhex(sys.argv[1])).rstrip(b"=").decode())' "$modulus_hex")"
  printf '{"kty":"RSA","use":"sig","alg":"RS256","kid":"%s","n":"%s","e":"AQAB"}' "$kid" "$modulus"
}

[ -f "$control_dir/jwt.key" ] || openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$control_dir/jwt.key" >/dev/null 2>&1
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$control_dir/jwt-next.key" >/dev/null 2>&1
printf '{"keys":[%s,%s]}' \
  "$(key_json "$control_dir/jwt.key" gate-current)" \
  "$(key_json "$control_dir/jwt-next.key" gate-next)" >"$control_dir/jwks.json"
printf '%s' gate-current >"$control_dir/active-kid"
printf '%s' 'cmp003-invitee@example.invalid' >"$control_dir/oidc-email"
printf '%s' 'gate-005-invited-user' >"$control_dir/oidc-subject"
printf '%s' 'gate-smtp-user' >"$control_dir/smtp-username"
printf '%s' 'gate-smtp-password-ephemeral' >"$control_dir/smtp-password"
printf '%s' '{"authorize":0,"token":0,"pkceVerified":0,"stateRoundTrips":0,"nonceSigned":0,"kids":[]}' >"$control_dir/oidc-stats.json"
printf '%s' '{"connections":0,"accepted":0,"temporary":0,"deadLetter":0,"authFailures":0,"recipients":{}}' >"$control_dir/smtp-stats.json"
chmod 600 "$control_dir"/*

#!/usr/bin/env bash
# Stage the WAF rules that protect /api/enrich.
#
# /api/enrich calls a model on behalf of whoever loads the page. Its shape already stops it being
# used as a general LLM proxy — a fixed set of passes, a whitelist of fields, no free-text, no model
# choice — but nothing in the request shape stops the same caller asking a thousand times. That is
# what these rules are for.
#
#   ./scripts/firewall.sh            # stage the rules, then show the diff
#   ./scripts/firewall.sh --tighten  # switch from log to enforcing, after reading the traffic
#
# Rules are STAGED, not live. Read `vercel firewall diff`, then publish them yourself:
#
#   vercel firewall publish --yes
#
# Requires a linked project (`vercel link`) and Vercel CLI >= 59, which is where `firewall` landed.

set -euo pipefail

RULE="Rate limit atlas enrichment"
PATH_PREFIX="/api/enrich"

# One atlas is about six requests: one partition, up to four narrate batches, one compose. Sixty
# requests in five minutes is roughly ten atlases from one address — far above anyone reading the
# map, far below anyone mining it.
WINDOW=300
REQUESTS=60

vercel() { command vercel "$@" 2>/dev/null || bunx vercel@latest "$@"; }

if [ "${1:-}" = "--tighten" ]; then
  # Only run this after reading the dashboard and confirming the rule matches abuse, not readers.
  # 429 rather than 403: a reader who trips it is not an attacker, and the browser client treats a
  # failed pass as "keep the templated map" either way.
  echo "Switching '$RULE' from log to enforcing (429)."
  vercel firewall rules edit "$RULE" \
    --condition "{\"type\":\"path\",\"op\":\"pre\",\"value\":\"$PATH_PREFIX\"}" \
    --action rate_limit \
    --rate-limit-window "$WINDOW" \
    --rate-limit-requests "$REQUESTS" \
    --rate-limit-keys ip \
    --rate-limit-action rate_limit \
    --yes
else
  # Stage 1 of the rollout: count and record, block nothing. Real traffic decides the real limit.
  echo "Staging '$RULE' in log mode ($REQUESTS requests / ${WINDOW}s per IP on $PATH_PREFIX)."
  vercel firewall rules add "$RULE" \
    --condition "{\"type\":\"path\",\"op\":\"pre\",\"value\":\"$PATH_PREFIX\"}" \
    --action rate_limit \
    --rate-limit-window "$WINDOW" \
    --rate-limit-requests "$REQUESTS" \
    --rate-limit-keys ip \
    --rate-limit-action log \
    --yes
fi

echo
vercel firewall diff
echo
echo "Nothing is live yet. Review the diff above, then run:"
echo "    vercel firewall publish --yes"

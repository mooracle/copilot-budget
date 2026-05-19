#!/usr/bin/env bash
set -euo pipefail
curl -fsSL "https://raw.githubusercontent.com/github/docs/main/data/tables/copilot/models-and-pricing.yml" \
     -o data/models-and-pricing.yml
test -s data/models-and-pricing.yml
echo "Updated data/models-and-pricing.yml ($(wc -c < data/models-and-pricing.yml) bytes)"

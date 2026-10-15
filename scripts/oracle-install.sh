#!/bin/bash
# Run on the Oracle server over SSH when the instance was created without the init script:
#   bash <(curl -fsSL ...)  is not possible for a private repo, so paste this whole file instead.
set -euo pipefail
read -rsp "GitHub token (input hidden): " GITHUB_TOKEN; echo
read -rp  "Setup code you'll type once in the app (8+ characters): " SETUP_CODE
read -rp  "Your email: " NOTIFY_EMAIL
curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" \
  https://raw.githubusercontent.com/RodHH/budget-app/main/scripts/oracle-cloud-init.sh -o /tmp/budget-setup.sh
sudo GITHUB_TOKEN="$GITHUB_TOKEN" SETUP_CODE="$SETUP_CODE" NOTIFY_EMAIL="$NOTIFY_EMAIL" bash /tmp/budget-setup.sh
rm -f /tmp/budget-setup.sh
echo; echo "Your app: $(cat /opt/budget/URL.txt)"

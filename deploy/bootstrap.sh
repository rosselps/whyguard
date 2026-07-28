#!/usr/bin/env bash
#
# Provisions the WhyGuard API on a fresh Amazon Linux 2023 instance, and updates it on
# every later run. Safe to re-run: it pulls, rebuilds and restarts, and never overwrites
# an existing .env.
#
#   sudo bash deploy/bootstrap.sh api.example.com   Caddy terminates TLS for that name
#   sudo bash deploy/bootstrap.sh --no-tls          plain HTTP on :80, for CloudFront
#
# Use --no-tls when something in front already terminates TLS and you have no domain of
# your own: a CloudFront distribution answers on https://<id>.cloudfront.net with a
# certificate AWS manages, which is enough for GitHub to deliver a webhook. Caddy stays
# in the path either way, so port 3000 is never exposed.
#
# Everything it installs is pinned or comes from the repository, so a second run on a
# different day produces the same box. It does not touch AWS: create the instance, the
# security group and the DNS record yourself first — see docs/deploy/aws.md.
set -euo pipefail

TARGET="${1:-}"
REPO_URL="${WHYGUARD_REPO_URL:-https://github.com/rosselps/whyguard.git}"
CADDY_VERSION="2.11.4"
NODE_MAJOR="24"

APP_USER="whyguard"
APP_HOME="/home/${APP_USER}"
APP_DIR="${APP_HOME}/app"

if [[ "${TARGET}" == "--no-tls" ]]; then
  # A bare port is a valid Caddy site address and turns automatic HTTPS off, which is
  # what makes this work without a name: there is no certificate to obtain.
  SITE_ADDRESS=":80"
  PUBLIC_URL="https://<your-distribution>.cloudfront.net"
elif [[ -n "${TARGET}" ]]; then
  SITE_ADDRESS="${TARGET}"
  PUBLIC_URL="https://${TARGET}"
else
  echo "usage: sudo bash deploy/bootstrap.sh <domain>|--no-tls" >&2
  echo "  <domain> must already resolve to this instance's public IP, or Caddy" >&2
  echo "  cannot obtain a certificate. Use --no-tls when CloudFront (or another" >&2
  echo "  proxy) terminates TLS in front of this box." >&2
  exit 1
fi
if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this with sudo." >&2
  exit 1
fi

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

step "System packages"
dnf install -y git tar gzip
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  dnf install -y nodejs
fi
# git is not a convenience here: the evidence engine runs `git log -S` to find the commit
# that introduced a behavior, so without it there is no analysis at all.
node --version
git --version
corepack enable

step "Service account"
id -u "${APP_USER}" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "${APP_USER}"
install -d -o "${APP_USER}" -g "${APP_USER}" -m 750 "${APP_HOME}/data" "${APP_HOME}/tmp"

step "Memory"
# EC2 instances ship with no swap, and the TypeScript build across the workspace peaks well
# above what a small instance has. The OOM killer does not explain itself: the build simply
# stops. Swap plus a serialized build is cheaper than a larger instance for a step that runs
# once per deploy.
memory_kb="$(awk '/MemTotal/{print $2}' /proc/meminfo)"
memory_mb="$((memory_kb / 1024))"
if [[ "${memory_mb}" -lt 1500 ]]; then
  # A t3.micro (~1 GB) also caps Node's heap far below what tsc wants, which surfaces as
  # "JavaScript heap out of memory" rather than as a kill. Raising the cap lets it spill
  # into swap: slow, but it finishes.
  SWAP_MB=4096
  BUILD_CONCURRENCY=1
  NODE_HEAP_MB=2048
else
  SWAP_MB=2048
  BUILD_CONCURRENCY=4
  NODE_HEAP_MB=3072
fi
if [[ -f /swapfile ]]; then
  echo "  ${memory_mb} MB RAM, swapfile already present"
else
  dd if=/dev/zero of=/swapfile bs=1M count="${SWAP_MB}" status=none
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  echo "  ${memory_mb} MB RAM, added ${SWAP_MB} MB of swap"
fi

step "Application"
if [[ -d "${APP_DIR}/.git" ]]; then
  sudo -u "${APP_USER}" git -C "${APP_DIR}" fetch --prune origin
  sudo -u "${APP_USER}" git -C "${APP_DIR}" reset --hard origin/main
else
  sudo -u "${APP_USER}" git clone "${REPO_URL}" "${APP_DIR}"
fi
cd "${APP_DIR}"
sudo -u "${APP_USER}" env HOME="${APP_HOME}" corepack prepare --activate
sudo -u "${APP_USER}" env HOME="${APP_HOME}" pnpm install --frozen-lockfile
sudo -u "${APP_USER}" env HOME="${APP_HOME}" NODE_OPTIONS="--max-old-space-size=${NODE_HEAP_MB}" \
  pnpm turbo run build --filter=@whyguard/api... --concurrency="${BUILD_CONCURRENCY}"

step "Configuration"
if [[ -f "${APP_DIR}/.env" ]]; then
  echo "  ${APP_DIR}/.env exists, left untouched"
else
  # Written as a template rather than prompted for: the private key is multi-line base64
  # and pasting it into a prompt over SSH is how it ends up truncated.
  cat >"${APP_DIR}/.env" <<EOF
PORT=3000
DATABASE_URL=file:${APP_HOME}/data/whyguard.db
WHYGUARD_TEMP_ROOT=${APP_HOME}/tmp

# From the GitHub App settings page. Base64 the .pem into one line:
#   base64 -w0 whyguard.private-key.pem
GITHUB_APP_ID=
GITHUB_PRIVATE_KEY_BASE64=
GITHUB_WEBHOOK_SECRET=

# Repositories the dashboard may show with no credential. Empty = closed to remote readers.
WHYGUARD_PUBLIC_REPOS=

# Amplify origin of the dashboard. Empty = every browser request from it fails CORS.
WHYGUARD_DASHBOARD_ORIGINS=

# Disk follows the repository, not the pull request.
WHYGUARD_MAX_REPO_SIZE_MB=1024

# Off means every explanation is the deterministic template, which is a supported mode.
WHYGUARD_LLM_ENABLED=false
AWS_REGION=us-east-1
BEDROCK_MODEL_ID=
EOF
  echo "  wrote ${APP_DIR}/.env — fill it in before starting the service"
fi
chown "${APP_USER}:${APP_USER}" "${APP_DIR}/.env"
chmod 600 "${APP_DIR}/.env"

step "Caddy ${CADDY_VERSION}"
case "$(uname -m)" in
x86_64) CADDY_ARCH="amd64" ;;
aarch64) CADDY_ARCH="arm64" ;;
*)
  echo "Unsupported architecture: $(uname -m)" >&2
  exit 1
  ;;
esac
# Not from dnf: Caddy is not in the Amazon Linux 2023 repositories, and the static binary
# from the release page has no dependencies.
if [[ "$(caddy version 2>/dev/null | cut -d' ' -f1)" != "v${CADDY_VERSION}" ]]; then
  tmp="$(mktemp -d)"
  curl -fsSL -o "${tmp}/caddy.tar.gz" \
    "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_${CADDY_ARCH}.tar.gz"
  tar -xzf "${tmp}/caddy.tar.gz" -C "${tmp}" caddy
  install -m 755 "${tmp}/caddy" /usr/bin/caddy
  rm -rf "${tmp}"
fi
id -u caddy >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/caddy --shell /usr/sbin/nologin caddy
install -d -o caddy -g caddy -m 750 /var/lib/caddy /var/log/caddy
install -d -m 755 /etc/caddy
install -m 644 "${APP_DIR}/deploy/Caddyfile" /etc/caddy/Caddyfile

cat >/etc/systemd/system/caddy.service <<EOF
[Unit]
Description=Caddy
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
Environment=WHYGUARD_DOMAIN=${SITE_ADDRESS}
ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile --force
Restart=on-abnormal
# Binding 80 and 443 as a non-root user.
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
EOF

step "Services"
install -m 644 "${APP_DIR}/deploy/whyguard-api.service" /etc/systemd/system/whyguard-api.service
systemctl daemon-reload
systemctl enable --now caddy
systemctl restart caddy

if grep -q '^GITHUB_APP_ID=.\+' "${APP_DIR}/.env"; then
  systemctl enable --now whyguard-api
  systemctl restart whyguard-api
  sleep 2
  systemctl is-active whyguard-api
else
  systemctl enable whyguard-api
  echo "  whyguard-api enabled but not started: .env has no GITHUB_APP_ID yet"
fi

cat <<EOF

  Done.

  Caddy is serving ${SITE_ADDRESS}

  1. Fill in ${APP_DIR}/.env        sudo -u ${APP_USER} vi ${APP_DIR}/.env
  2. sudo systemctl restart whyguard-api
  3. sudo journalctl -u whyguard-api -n 30    the boot log names the read-access mode
  4. Point the GitHub App webhook at ${PUBLIC_URL}/webhooks/github
  5. From your laptop:  node scripts/verify-deployment.mjs --url ${PUBLIC_URL}

EOF

# Sandbox image for the pi "lambda-microvm" extension.
# Amazon Linux 2023 (Lambda base container image, snapshot-compatible OpenSSL) + common dev tools
# + Node.js LTS + a tiny Node.js agent (server.js) that exposes exec/filesystem over HTTP on port 8080.
FROM public.ecr.aws/lambda/microvms:al2023-minimal

# "lts" = newest LTS release from nodejs.org at build time; or pin e.g. NODE_VERSION=v24.11.1
ARG NODE_VERSION=lts

RUN set -eux; \
    PM=$(command -v dnf || command -v microdnf); \
    $PM -y install bash tar gzip xz findutils grep sed gawk procps-ng which file diffutils patch \
        git python3 python3-pip jq unzip less shadow-utils libatomic libstdc++; \
    $PM clean all; \
    case "$(uname -m)" in aarch64) ARCH=arm64 ;; x86_64) ARCH=x64 ;; *) echo "unsupported arch" >&2; exit 1 ;; esac; \
    if [ "$NODE_VERSION" = "lts" ]; then \
      NODE_VERSION=$(curl -fsSL https://nodejs.org/dist/index.json | jq -r '[.[] | select(.lts != false)][0].version'); \
    fi; \
    curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-${ARCH}.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1 --exclude CHANGELOG.md --exclude README.md --exclude LICENSE; \
    node --version; npm --version; bash --version | head -1

ENV MVM_WORKSPACE=/workspace \
    HOME=/root \
    LANG=C.UTF-8

WORKDIR /workspace
COPY server.js /opt/pi-mvm-agent/server.js

EXPOSE 8080 9000
CMD ["node", "/opt/pi-mvm-agent/server.js"]

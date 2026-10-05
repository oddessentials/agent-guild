# A Linux computer with systemd as PID 1, tmux and Node.js, for the boot
# service's acceptance run (acceptance.sh). Not part of the package.
FROM ubuntu:24.04
ARG NODE_VERSION=22.20.0
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends systemd systemd-sysv dbus-user-session ca-certificates curl xz-utils tmux locales \
 && apt-get clean && rm -rf /var/lib/apt/lists/*
RUN ARCH=$(dpkg --print-architecture | sed 's/amd64/x64/') \
 && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${ARCH}.tar.xz" | tar -xJ -C /opt \
 && ln -s "/opt/node-v${NODE_VERSION}-linux-${ARCH}/bin/node" /usr/local/bin/node \
 && ln -s "/opt/node-v${NODE_VERSION}-linux-${ARCH}/bin/npm" /usr/local/bin/npm
RUN locale-gen en_US.UTF-8 && echo 'LANG=en_US.UTF-8' > /etc/locale.conf
RUN useradd -m -s /bin/bash guild
CMD ["/sbin/init"]

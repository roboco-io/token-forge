#!/usr/bin/env bash
# SSM 명령 밖의 독립 프로세스로 실행한 후 marker를 보고 NoReboot AMI를 만든다.
set -euo pipefail
umask 077
[ -f /opt/token-forge/builder-only ] || { echo "Dedicated builder marker required" >&2; exit 2; }
# Disable/remove persistent builder timers BEFORE starting this isolated cleanup job.
# Do not reload systemd while the capture worker is running.
systemctl stop docker.service docker.socket containerd.service
systemctl stop amazon-ssm-agent.service 2>/dev/null || systemctl stop snap.amazon-ssm-agent.amazon-ssm-agent.service
cloud-init clean --logs --machine-id --seed
rm -f /etc/ssh/ssh_host_* /var/lib/dbus/machine-id
ln -s /etc/machine-id /var/lib/dbus/machine-id
rm -rf /var/lib/amazon/ssm/* /var/log/amazon/ssm/* /root/.aws /home/ubuntu/.aws
rm -f /root/.bash_history /home/ubuntu/.bash_history /root/.ssh/authorized_keys /home/ubuntu/.ssh/authorized_keys
rm -rf /tmp/* /var/tmp/*
# No builder userdata, instance IDs, downloaded weights, or command history in snapshot.
rm -f /var/log/cloud-init* /var/log/seed.log /var/log/prebootstrap-builder.log
systemctl stop rsyslog.service 2>/dev/null || true
systemctl stop systemd-journald.socket systemd-journald-dev-log.socket systemd-journald.service
find /var/log -type f -exec truncate -s 0 {} +
rm -rf /var/log/journal/* /var/lib/dhcp/*
printf 'localhost\n' > /etc/hostname
rm -f /opt/token-forge/capture.sh /etc/systemd/system/tkf-capture-*.service
sync
touch /opt/token-forge/sanitized

#!/usr/bin/env bash
# 전용 CPU Spot 빌더에서만 실행. 모델/API 키는 전달하지 않는다.
set -euo pipefail
umask 077
[ -f /opt/token-forge/builder-only ] || { echo "Dedicated builder marker required" >&2; exit 2; }
IMAGE=${1:?pinned repository@sha256 digest required}
[[ "$IMAGE" =~ @sha256:[0-9a-f]{64}$ ]] || exit 2
install -d -m 700 /opt/token-forge
systemctl stop docker.service docker.socket containerd.service
# DLAMI의 NVMe 링크를 영구 루트 볼륨의 디렉터리로 전환한다.
for name in docker containerd; do
  src=/var/lib/$name
  if [ -L "$src" ]; then
    target=$(readlink -f "$src")
    mkdir -p /opt/token-forge/$name
    if [ -d "$target" ]; then cp -a "$target/." /opt/token-forge/$name/; fi
    rm "$src"
    mv /opt/token-forge/$name "$src"
  fi
  mkdir -p "$src"
  [ "$(findmnt -n -o SOURCE -T "$src")" = "$(findmnt -n -o SOURCE /)" ]
done
# Explicit persistent roots survive daemon restarts; reject conflicting custom roots.
python3 - <<'PY'
import json,pathlib
p=pathlib.Path('/etc/docker/daemon.json')
c=json.loads(p.read_text()) if p.exists() else {}
c['data-root']='/var/lib/docker'
p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(c))
p=pathlib.Path('/etc/containerd/config.toml')
if p.exists():
 import re
 s=p.read_text()
 s=re.sub(r'^root\s*=.*$', 'root = "/var/lib/containerd"', s, flags=re.M)
 p.write_text(s)
PY
systemctl start containerd docker
docker pull "$IMAGE"
docker image inspect "$IMAGE" >/dev/null
# create+start forces unpack/mount, unlike pull alone. CPU can run this without CUDA.
id=$(docker create --runtime runc --entrypoint /bin/sh "$IMAGE" -c 'test -d /usr/local && echo unpack-verified')
trap 'docker rm -f "$id" >/dev/null 2>&1 || true' EXIT
docker start -a "$id"
docker rm "$id" >/dev/null
trap - EXIT
[ "$(docker info --format '{{.DockerRootDir}}')" = /var/lib/docker ]
sync

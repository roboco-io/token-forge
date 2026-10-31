#!/usr/bin/env python3
"""Trusted local AMI cache only. CLI failures cause the boot caller to compile normally."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile


def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1024 * 1024), b''):
            h.update(b)
    return h.hexdigest()


def restore(bundle, destination, identity):
    bundle, destination = Path(bundle), Path(destination)
    manifest = json.loads((bundle / 'manifest.json').read_text())
    if manifest.get('v') != 1 or manifest.get('identity') != identity:
        raise ValueError('cache compatibility mismatch')
    archive = bundle / 'cache.tar'
    if sha(archive) != manifest.get('sha256'):
        raise ValueError('cache hash mismatch')
    with tarfile.open(archive) as t:
        members = t.getmembers()
        if not members:
            raise ValueError('empty cache')
        for m in members:
            parts = Path(m.name).parts
            if not parts or parts[0] != 'torch_compile_cache' or '..' in parts or not (m.isfile() or m.isdir()):
                raise ValueError('unsafe cache entry')
        destination.parent.mkdir(parents=True, exist_ok=True)
        stage = Path(tempfile.mkdtemp(prefix='.cache-', dir=destination.parent))
        try:
            for m in members:
                target = stage / m.name
                if m.isdir():
                    target.mkdir(parents=True, exist_ok=True, mode=0o700)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    with t.extractfile(m) as src, target.open('wb') as dst:
                        shutil.copyfileobj(src, dst)
                    target.chmod(0o600)
            if destination.exists():
                raise ValueError('runtime cache already exists')
            stage.rename(destination)
        finally:
            if stage.exists():
                shutil.rmtree(stage)


def identity():
    e = os.environ
    model = Path(e['MODEL_DIR'])
    gpu = subprocess.check_output(['nvidia-smi', '--query-gpu=name,driver_version', '--format=csv,noheader'], text=True).strip()
    digest = subprocess.check_output(['docker', 'image', 'inspect', '--format', '{{json .RepoDigests}}', e['VLLM_IMAGE']], text=True)
    return {'image': sorted(json.loads(digest)), 'model': e['WEIGHTS_REPO'],
            'revision': (model / '.tkf-revision').read_text().strip(), 'config': sha(model / 'config.json'),
            'flags': e['VLLM_FLAGS'], 'maxlen': e['MAX_MODEL_LEN'], 'gpu_driver': gpu,
            'container_cache_path': '/root/.cache/vllm', 'uid': 0}


if __name__ == '__main__':
    try:
        restore('/opt/token-forge/prebootstrap', '/run/token-forge/vllm-cache', identity())
        print('/run/token-forge/vllm-cache')
        print('prebootstrap: verified cache restored; native vLLM hash decides reuse', file=sys.stderr)
    except Exception as error:
        print('prebootstrap: normal compile fallback: ' + str(error), file=sys.stderr)
        sys.exit(1)

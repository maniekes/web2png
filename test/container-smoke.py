#!/usr/bin/env python3
"""GitHub-hosted runner smoke test. Never uses real configs or external targets."""
import json
import os
from pathlib import Path
import selectors
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
IMAGE = os.environ.get('TEST_IMAGE', 'web2png:ci')
NAME = 'web2png-ci'


def docker(*args, capture=False, check=True):
    return subprocess.run(['docker', *args], check=check, text=True,
                          stdout=subprocess.PIPE if capture else None,
                          timeout=180)


def inspect():
    return json.loads(docker('inspect', NAME, capture=True).stdout)[0]


def healthy():
    deadline = time.monotonic() + 75
    while time.monotonic() < deadline:
        state = inspect()['State']
        assert state['Running'], 'Container exited before becoming healthy'
        if state.get('Health', {}).get('Status') == 'healthy':
            return
        time.sleep(1)
    raise AssertionError('Health check deadline exceeded')


def stopped():
    state = inspect()['State']
    assert not state['Running'], state
    assert state['ExitCode'] == 0, state
    assert not state['OOMKilled'], state


mounts = ['--mount', f'type=bind,src={ROOT / "test"},dst=/app/test,readonly',
          '--mount', f'type=bind,src={ROOT / "security"},dst=/app/security,readonly',
          '--mount', f'type=bind,src={ROOT / "test/fixtures/synthetic-config.yaml"},dst=/config/device-mappings.yaml,readonly']
hardening = ['--init', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
             '--security-opt', 'no-new-privileges:true',
             '--security-opt', f'seccomp={ROOT / "security/seccomp-chromium.json"}',
             '--shm-size', '256m',
             '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m,mode=1777',
             '--tmpfs', '/home/node:rw,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=700']

if os.environ.get('TEST_APPARMOR_PROFILE'):
    hardening += ['--security-opt', 'apparmor=' + os.environ['TEST_APPARMOR_PROFILE']]

try:
    # Unit/HTTP tests also execute on the exact image Node/dependencies.
    docker('run', '--rm', *hardening, *mounts, '--entrypoint', 'node', IMAGE,
           '--test', 'test/http.test.js', 'test/runtime-policy.test.js')
    docker('run', '-d', '--name', NAME, *hardening, *mounts, IMAGE)
    healthy()
    assert inspect()['Config']['User'] == 'node'
    # Explicit diagnostic probe, no URL or private config involved. Failure is
    # intentional evidence of unsupported sandboxing, not permission to bypass it.
    docker('exec', NAME, 'node', '--input-type=module', '-e',
           "import puppeteer from 'puppeteer'; "
           "const b=await puppeteer.launch(); "
           "if(b.process().spawnargs.some(a=>a==='--no-sandbox'||a==='--disable-setuid-sandbox')) throw Error('Sandbox disabled'); "
           "console.log(await b.version()); await b.close();")
    docker('exec', NAME, 'node', 'test/render-check.js')
    docker('stop', '--time', '15', NAME)
    stopped()
    docker('start', NAME)
    healthy()
    docker('exec', NAME, 'node', 'test/render-check.js')
    # Stop while Chrome is actually navigating, not merely after dispatch.
    client = subprocess.Popen(['docker', 'exec', NAME, 'node', 'test/render-check.js', '--inflight'],
                              text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    selector = selectors.DefaultSelector()
    assert client.stdout is not None
    selector.register(client.stdout, selectors.EVENT_READ)
    try:
        assert selector.select(timeout=40), 'No in-flight fixture request observed'
        assert client.stdout.readline().strip() == 'FIXTURE_REQUESTED', 'Navigation did not reach fixture'
        started = time.monotonic()
        docker('stop', '--time', '15', NAME)
        assert time.monotonic() - started < 15, 'Shutdown exceeded grace period'
        stopped()
        client.wait(timeout=5)
    finally:
        selector.close()
        if client.poll() is None:
            client.kill()
            client.wait()
    print('Container health, real PNG rendering, restart and idle/in-flight SIGTERM passed.')
finally:
    docker('logs', NAME, check=False)
    docker('rm', '-f', NAME, check=False)

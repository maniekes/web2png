import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';

const root = new URL('../', import.meta.url);
const read = path => fs.readFileSync(new URL(path, root), 'utf8');

test('browser seccomp only adds the three documented namespace syscalls to Docker default', () => {
    assert.ok(fs.existsSync(new URL('security/seccomp-chromium.json', root)), 'explicit sandbox-compatible profile is required');
    const baselineText = read('test/fixtures/seccomp-moby-28.0.4.json');
    assert.equal(crypto.createHash('sha256').update(baselineText).digest('hex'), '9c1025c88ccaa517b648da571961838744ea2137f176bfe6a48b21294cae9c76');
    const baseline = JSON.parse(baselineText);
    const profile = JSON.parse(read('security/seccomp-chromium.json'));
    assert.equal(profile.defaultAction, 'SCMP_ACT_ERRNO');
    const extra = profile.syscalls.pop();
    assert.deepEqual(extra, {
        names: ['clone', 'setns', 'unshare'],
        action: 'SCMP_ACT_ALLOW',
        comment: 'Allow Chromium to create its own unprivileged user namespace sandbox.'
    });
    assert.deepEqual(profile, baseline, 'all other Docker seccomp restrictions must be preserved');
});

test('AppArmor profile enables user namespaces but keeps filesystem and mount restrictions', () => {
    assert.ok(fs.existsSync(new URL('security/apparmor-web2png', root)), 'dedicated AppArmor profile is required');
    const text = read('security/apparmor-web2png');
    assert.match(text, /profile web2png-browser flags=\(attach_disconnected,mediate_deleted\)/);
    assert.match(text, /^\s+userns,\s*$/m);
    assert.match(text, /^\s+deny mount,\s*$/m);
    assert.match(text, /deny @\{PROC\}\/sysrq-trigger rwklx,/);
    assert.match(text, /deny \/sys\/kernel\/security\/\*\* rwklx,/);
    assert.doesNotMatch(text, /flags=\([^)]*(?:unconfined|complain)/);
});

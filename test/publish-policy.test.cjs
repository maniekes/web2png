const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const root = path.resolve(__dirname, '..');
const load = file => yaml.load(fs.readFileSync(path.join(root, file), 'utf8'));
const masterOnly = "github.event_name == 'push' && github.ref == 'refs/heads/master' && github.repository == 'maniekes/web2png'";

test('the shared job publishes the tested image only after successful tests', () => {
    assert.ok(fs.existsSync(path.join(root, '.github/workflows/container-build.yml')), 'shared build/test workflow is required');
    const workflow = load('.github/workflows/container-build.yml');
    assert.deepEqual(Object.keys(workflow.on), ['workflow_call']);
    assert.equal(workflow.on.workflow_call.inputs.publish.default, false);
    assert.equal(workflow.on.workflow_call.inputs.publish.type, 'boolean');
    assert.equal(workflow.permissions, undefined, 'inherit caller-scoped permissions');
    const steps = workflow.jobs.container.steps;
    const runText = steps.map(s => s.run || '').join('\n');
    assert.equal((runText.match(/docker build /g) || []).length, 1);
    const build = steps.findIndex(s => s.run?.includes('docker build '));
    const smoke = steps.findIndex(s => s.run === 'python3 test/container-smoke.py');
    const publish = steps.findIndex(s => s.run?.includes('docker push '));
    assert.ok(build >= 0 && build < smoke && smoke < publish);
    assert.equal(steps[publish].if, `inputs.publish && ${masterOnly}`);
    assert.equal(steps[publish]['continue-on-error'], undefined);
    assert.equal(steps[smoke]['continue-on-error'], undefined);
    assert.match(steps[build].run, /--tag web2png:ci/);
    assert.match(steps[build].run, /org.opencontainers.image.source=/);
    assert.match(steps[build].run, /org.opencontainers.image.revision=/);
    assert.match(steps[publish].run, /docker image inspect web2png:ci/);
    assert.match(steps[publish].run, /docker tag "\$image_id" "\$image:sha-\$GITHUB_SHA"/);
    assert.match(steps[publish].run, /docker tag "\$image_id" "\$image:latest"/);
    assert.match(steps[publish].run, /--password-stdin/);
    assert.equal(steps[publish].env.GHCR_TOKEN, '${{ github.token }}');
    assert.match(steps[publish].run, /git ls-remote/);
    assert.match(steps[publish].run, /docker manifest inspect "\$image:sha-\$GITHUB_SHA"/);
    assert.match(steps[publish].run, /trap .*docker logout ghcr.io.* EXIT/);
    assert.equal(steps.find(s => s.run?.includes('apparmor_parser -R')).if, 'always()');
    for (const step of steps) {
        if (/docker (login|push) /.test(step.run || '')) assert.equal(step, steps[publish]);
        if (step.uses) assert.match(step.uses, /^actions\/checkout@[0-9a-f]{40}$/);
    }
});

test('Compose pulls GHCR without building and keeps deployment restrictions', () => {
    const service = load('compose.example.yaml').services.web2png;
    assert.equal(service.build, undefined);
    assert.equal(service.image, '${WEB2PNG_IMAGE:-ghcr.io/maniekes/web2png:latest}');
    assert.equal(service.platform, 'linux/amd64');
    assert.equal(service.read_only, true);
    assert.deepEqual(service.cap_drop, ['ALL']);
    assert.ok(service.security_opt.includes('no-new-privileges:true'));
    assert.ok(service.security_opt.includes('seccomp=./security/seccomp-chromium.json'));
    assert.equal(service.volumes[0].read_only, true);
    assert.equal(service.volumes[0].bind.create_host_path, false);
    assert.match(service.volumes[0].source, /^\$\{WEB2PNG_CONFIG:\?/);
    assert.equal(service.privileged, undefined);
    assert.equal(service.network_mode, undefined);
});

test('only upstream master pushes can request publishing permissions', () => {
    const workflow = load('.github/workflows/container-ci.yml');
    assert.ok(workflow.on.push.branches.includes('master'));
    assert.ok(workflow.on.push.branches.includes('feat/publish-ghcr'));
    assert.deepEqual(Object.keys(workflow.on).sort(), ['pull_request', 'push']);
    assert.deepEqual(workflow.permissions, {contents: 'read'});
    assert.equal(workflow.jobs.publish.if, masterOnly);
    assert.deepEqual(workflow.jobs.publish.permissions, {contents: 'read', packages: 'write'});
    assert.equal(workflow.jobs.publish.with.publish, true);
    assert.equal(workflow.jobs.test.if, `!(${masterOnly})`);
    assert.deepEqual(workflow.jobs.test.permissions, {contents: 'read'});
    assert.equal(workflow.jobs.test.with.publish, false);
    assert.equal(workflow.jobs.test.uses, './.github/workflows/container-build.yml');
    assert.equal(workflow.jobs.publish.uses, workflow.jobs.test.uses);
    assert.equal(workflow.concurrency.group, 'container-ci-${{ github.ref }}');
    assert.equal(workflow.concurrency['cancel-in-progress'], "${{ github.ref != 'refs/heads/master' }}");
});

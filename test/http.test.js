import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {connect} from 'node:net';

const validConfig = 'default:\n  resolution: 32x24\n  delay: 0\ndevices: {}\n';
async function start(t, config = validConfig) {
    const dir = await mkdtemp(join(tmpdir(), 'web2png-test-'));
    const path = join(dir, 'config.yaml');
    await writeFile(path, config);
    const child = spawn(process.execPath, ['web2png.js', '-c', path, '-p', '0']);
    let logs = '';
    child.stdout.on('data', data => { logs += data; });
    child.stderr.on('data', data => { logs += data; });
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
            await once(child, 'exit');
        }
        await rm(dir, {recursive: true, force: true});
    });
    for (let i = 0; i < 100; i++) {
        // Discover the real ephemeral listener via the startup line.
        const match = logs.match(/localhost:(\d+)/);
        if (match) return {child, path, url: `http://127.0.0.1:${match[1]}`, logs: () => logs};
        if (child.exitCode !== null) throw new Error('Server exited before listening');
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Server did not start');
}

test('SIGTERM closes the idle HTTP server successfully', async t => {
    const server = await start(t);
    const exit = once(server.child, 'exit');
    server.child.kill('SIGTERM');
    const [code, signal] = await exit;
    assert.equal(signal, null);
    assert.equal(code, 0);
});

test('shutdown deadline bounds an unfinished HTTP request', {timeout: 15000}, async t => {
    const server = await start(t);
    const socket = connect(Number(new URL(server.url).port), '127.0.0.1');
    t.after(() => socket.destroy());
    await once(socket, 'connect');
    socket.write('GET /healthz HTTP/1.1\r\nHost: localhost\r\n');
    await new Promise(resolve => setTimeout(resolve, 100));
    const exit = once(server.child, 'exit');
    server.child.kill('SIGTERM');
    const [code, signal] = await exit;
    assert.equal(signal, null);
    assert.equal(code, 1);
    assert.match(server.logs(), /Shutdown deadline exceeded/);
});

test('legacy CLI sample/help/version and argument precedence still work', async t => {
    for (const [flag, pattern] of [['--help', /Usage:/], ['--version', /1\.0\.4/], ['--print-sample-config', /devices:/]]) {
        const result = spawnSync(process.execPath, ['web2png.js', flag], {encoding: 'utf8'});
        assert.equal(result.status, 0);
        assert.match(result.stdout, pattern);
    }
    const dir = await mkdtemp(join(tmpdir(), 'web2png-cli-'));
    t.after(() => rm(dir, {recursive: true, force: true}));
    const path = join(dir, 'sample.yaml');
    const result = spawnSync(process.execPath, ['web2png.js', '-g', '-c', path], {
        encoding: 'utf8', env: {...process.env, CONFIG_FILE: join(dir, 'nonexistent', 'ignored.yaml')},
    });
    assert.equal(result.status, 0);
    const server = await start(t);
    const response = await fetch(`${server.url}/screenshot?device=unknown`);
    assert.equal(response.status, 500);
    assert.equal(await response.text(), 'device not found in configuration list!');
});

test('missing configuration prevents startup', () => {
    const result = spawnSync(process.execPath, ['web2png.js', '-c', '/nonexistent-web2png-test/config.yaml'], {encoding: 'utf8'});
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Error loading configuration/);
});

test('health reports config availability and rechecks changed config', async t => {
    const server = await start(t);
    assert.notEqual(server.url, 'http://127.0.0.1:0', 'startup reports actual listening port');
    let response = await fetch(`${server.url}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {status: 'ok'});
    await writeFile(server.path, 'devices: [invalid');
    response = await fetch(`${server.url}/healthz`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {status: 'unavailable'});
    await writeFile(server.path, validConfig);
    assert.equal((await fetch(`${server.url}/healthz`)).status, 200);
    await rm(server.path);
    assert.equal((await fetch(`${server.url}/healthz`)).status, 503);
});

// Real-browser assertions; only run inside the isolated CI container.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {readdir, readFile} from 'node:fs/promises';
import sharp from 'sharp';

const inflight = process.argv.includes('--inflight');
const fixture = createServer((req, res) => {
    if (req.url.startsWith('/fail/')) return req.socket.destroy();
    if (req.url === '/slow') {
        console.log('FIXTURE_REQUESTED');
        // Deliberately keep a navigation in flight for the SIGTERM check.
        return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><head><style>html,body{margin:0;width:32px;height:24px;background:rgb(32,96,160)}</style></head><body></body></html>');
});
fixture.listen(8080, '127.0.0.1');
await once(fixture, 'listening');
const base = 'http://127.0.0.1:3001';
async function screenshot(query = '') {
    const response = await fetch(`${base}/screenshot?device=fixture${query}`, {signal: AbortSignal.timeout(30000)});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    const png = Buffer.from(await response.arrayBuffer());
    assert.equal(Number(response.headers.get('content-length')), png.length);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    const metadata = await sharp(png).metadata();
    assert.equal(metadata.width, 32);
    assert.equal(metadata.height, 24);
    const {data} = await sharp(png).removeAlpha().toColourspace('srgb').raw().toBuffer({resolveWithObject: true});
    return [...data.subarray(0, 3)];
}
try {
    if (inflight) {
        // Container shutdown may terminate this exec as well as the request.
        await fetch(`${base}/screenshot?device=slow`, {signal: AbortSignal.timeout(30000)}).catch(() => {});
    } else {
        assert.deepEqual(await screenshot(), [32, 96, 160]);
        assert.deepEqual(await screenshot('&negate=true'), [223, 159, 95]);
        const gray = await screenshot('&grayscale=true');
        assert.equal(gray[0], gray[1]);
        assert.equal(gray[1], gray[2]);
        assert.equal((await fetch(`${base}/screenshot?device=broken`, {signal: AbortSignal.timeout(30000)})).status, 500);
        // Failure must not poison subsequent rendering.
        assert.deepEqual(await screenshot(), [32, 96, 160]);
        // Browser cleanup: no remaining Chrome processes after requests settle.
        for (let attempt = 0; ; attempt++) {
            const processes = await Promise.all((await readdir('/proc')).filter(p => /^\d+$/.test(p)).map(async p => {
                try { return await readFile(`/proc/${p}/comm`, 'utf8'); } catch { return ''; }
            }));
            if (!processes.some(name => /chrome/.test(name))) break;
            assert.ok(attempt < 30, 'Chrome processes remain after rendering');
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        console.log('Real PNG dimensions, pixels, grayscale, negate and browser cleanup passed.');
    }
} finally {
    fixture.closeAllConnections();
    await new Promise(resolve => fixture.close(resolve));
}

# Container build and compatibility checks

This change keeps web2png **1.0.4 and its existing package-lock.json**. It does not
publish an image, update dependencies or deploy a service. The intended sequence is
feature-branch CI, review/merge, then a separately executed Compose deployment
using these same application/browser versions. Version upgrades are a later task.

## Image and browser

- Base: `node:22-bookworm-slim`, pinned by the verified multi-platform manifest
  digest in `Dockerfile`; this first build/test targets **linux/amd64 only**.
- Existing dependency chain: Pageres **8.1.0** → capture-website **4.2.0** →
  Puppeteer **23.11.1** → Chrome for Testing **131.0.6778.204**. These versions
  were read from the lockfile and installed Puppeteer revisions, not inferred
  from a floating browser tag.
- `npm ci` downloads the compatible Chrome during image build. The unused
  headless-shell download is disabled. Runtime installs/downloads nothing and
  needs neither Hermes nor a separate browser service.
- Chrome 131 is a legacy browser with security exposure. Keeping it here is an
  intentional compatibility decision, **not a claim of current browser security**.
  An upgrade of the browser/dependency pair is explicitly separate from this
  containerization and the user's staged deployment.
- The base digest and npm lock are pinned; Debian packages are resolved at build
  time from the distribution repositories. Builds are not byte-for-byte
  reproducible. Record the resulting image ID/digest when promoting a tested build.

## Sandbox and runtime boundaries

The inspected Pageres/capture-website chain does **not** disable the Chrome
sandbox. Neither this application nor the image adds `--no-sandbox` or
`--disable-setuid-sandbox`. There is no privileged mode, `SYS_ADMIN`, host Docker
socket, host networking or host security-policy change.

The example runs as the image's `node` user (UID 1000), with an init, all capabilities
dropped, no-new-privileges, a read-only root filesystem and bounded writable tmpfs
mounts for `/tmp` and the user's home. Chrome cache is readable but not writable.
The host must support sandboxed Chrome under these restrictions. Docker seccomp,
user-namespace policy or host AppArmor can prevent this. **A sandbox error is a
failed compatibility test, not permission to disable the sandbox.** CI emits a
standalone launch diagnostic before rendering so the actual error is visible.
Consult Puppeteer's official troubleshooting documentation for diagnosis; do not
apply privileged/no-sandbox recipes automatically.

The screenshot endpoint is unauthenticated and can fetch configured URLs, their
redirects and subresources. Query parameters still allow expensive renders. Use
only trusted pages/configuration, restrict network access, and do not expose this
service directly to the Internet. A loopback bind does not restrict browser egress.
Existing application logging is intentionally unchanged: device objects, URLs and
error details can appear in logs. Treat runtime logs as sensitive. CI has only
synthetic data and no runtime network access outside its container.

## Build and test (on an authorized Docker machine)

```sh
docker build --platform linux/amd64 --tag web2png:ci .
python3 test/container-smoke.py
```

The smoke script uses a container named `web2png-ci` (reserve that name for tests)
and removes it afterwards. Fixtures/tests are mounted read-only, not baked into
the runtime image. It runs with `--network none`: the only page served is generated
synthetic HTML on container loopback. There are no requests to home services or
external pages. Build-time package/browser downloads still require Internet access.

The test checks:

- Node HTTP/CLI tests using the image's actual Node and dependencies;
- image non-root user, `/healthz` and Docker health status;
- real sandboxed browser launch and its reported version;
- real PNG signature, headers, decoded 32×24 dimensions and known color pixels;
- grayscale and negate, render-error recovery and Chrome process cleanup;
- idle stop/start, rendering after restart, and SIGTERM during an observed browser
  navigation; stopped containers must have exit code 0 (not a forced kill).

A failed browser launch fails the job; it is never replaced with a mock PNG.
The Actions workflow runs on GitHub-hosted Ubuntu for feature-branch pushes and
pull requests, uses a verified checkout action commit with credentials not persisted,
and grants only `contents: read`. There is no registry login, push, publish, secret,
self-hosted runner or deployment step. The existing release/npm workflow is unchanged.

For local HTTP/CLI tests without downloading Chrome:

```sh
PUPPETEER_SKIP_DOWNLOAD=true npm ci --no-audit --no-fund
npm test
```

These tests do **not** prove browser rendering or image compatibility.

## Compose example (not automatically deployed)

`compose.example.yaml` is an example to review before deployment. On the intended
Docker host, prepare a private YAML config **outside the repository**, readable by
UID 1000. Do not put credentials or real dashboard URLs in this public repository.
Then, only when deployment is authorized and the sandbox/runtime checks pass:

```sh
export WEB2PNG_CONFIG=/absolute/private/path/device-mappings.yaml
docker compose -f compose.example.yaml build
docker compose -f compose.example.yaml up -d
```

The config is explicitly mounted read-only at `/config/device-mappings.yaml`;
Compose fails rather than creating a directory when the source is missing. It is
re-read on every screenshot request, so mounted configuration changes are visible.
The proposed bind is **127.0.0.1:13001 → container:3001**. Port 13001 is an example,
not a claim that it is available on the target host. Host port 3001 is deliberately
avoided. Loopback-only access is not a remote-device integration by itself; choose
any proxy/network integration separately. Compose uses a local image only and
`restart: unless-stopped`; no automatic image updater is included.

`CONFIG_FILE` and `CONFIG_PORT` are explicit in the example. Keep `CONFIG_PORT`
aligned with the container port mapping; image health checks use that environment
value. CLI `-c`/`-p` remain usable outside Docker.

`GET /healthz` returns 200 when the running process can read and parse the YAML,
503 if that fails. It is **not schema validation, browser readiness, target-page
reachability, or a successful render**. Missing/unparseable config at startup still
prevents startup. Docker marking a process unhealthy does not itself restart it.

SIGTERM stops accepting HTTP connections, allows in-flight cleanup, and forces exit
with code 1 after a 10-second deadline if necessary. Compose gives it 15 seconds
before its own forced kill. A navigation interrupted by shutdown may fail; completed
render delivery is not promised during shutdown.

## Preserved legacy behavior

No logging cleanup, rendering-option rewrite, dependency upgrade or npm release
workflow modification is included. Existing caveats remain: the sample says delay
is milliseconds, but capture-website treats it as seconds; query strings such as
`grayscale=false` are truthy; full-page screenshots may exceed viewport height; and
`package.json` still references the pre-existing absent `main: index.js`. Tests use
`delay: 0`, explicit truthy transform queries and non-overflowing synthetic HTML.

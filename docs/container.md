# Container publishing and pull-only deployment

This change keeps web2png **1.0.4 and its existing package-lock.json**. After
review/merge, successful `master` CI publishes the tested image to
`ghcr.io/maniekes/web2png`; it does not deploy a service or create a GitHub/npm
release. Feature branches and PRs only build/test. Dependency/browser upgrades
remain a separate task.

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
socket or host networking. CI loads a dedicated AppArmor profile on its ephemeral
runner; it does not disable a host-wide restriction or change the production host.

The example runs as the image's `node` user (UID 1000), with an init, all capabilities
dropped, no-new-privileges, a read-only root filesystem and bounded writable tmpfs
mounts for `/tmp` and the user's home. Chrome cache is readable but not writable.
The host must support sandboxed Chrome under these restrictions. Docker seccomp,
user-namespace policy or host AppArmor can prevent this. **A sandbox error is a
failed compatibility test, not permission to disable the sandbox.** CI emits a
standalone launch diagnostic before rendering so the actual error is visible.
Consult Puppeteer's official troubleshooting documentation for diagnosis; do not
apply privileged/no-sandbox recipes automatically.

The initial GitHub runner failed the namespace/browser probes under Docker's
built-in policy. `security/seccomp-chromium.json` preserves the Moby v28.0.4
Docker default profile, adding only `clone`, `setns`, `unshare` and `chroot`
permissions so Chromium can construct its own unprivileged namespace sandbox.
The real CI launch confirmed Chromium also needs `chroot` inside its new user
namespace; Docker's default allows that syscall only with container CAP_SYS_CHROOT,
which remains dropped here. The kernel still enforces chroot's capability check;
no capability is added to the initial container namespace. The baseline
is in `test/fixtures/seccomp-moby-28.0.4.json`; its SHA-256 and the exact delta
are checked by `test/runtime-policy.test.js`. This expands the permitted syscall
surface and needs review, but does not add container capabilities or turn off
seccomp. The pattern is documented in Playwright's Docker sandbox guidance.

On AppArmor hosts, `security/apparmor-web2png` derives from Moby v28.0.4's default
container profile, retaining its mount/proc/sys restrictions and adding `userns`.
CI loads it as `web2png-browser` and selects it only for these test containers.
It leaves global AppArmor/sysctl settings unchanged and unloads the profile after
tests. On an authorized AppArmor test host, load this profile and set
`TEST_APPARMOR_PROFILE=web2png-browser` before running the smoke script. For a real
Compose deployment on such a host, explicitly select the loaded profile using
`apparmor=web2png-browser` as indicated in the example. On hosts using another LSM,
verify that host's policy separately; no AppArmor installation or SELinux changes
are performed automatically. The seccomp profile must be available to the Docker
client/Compose deployment process; it is not a file mounted into the application.

Profile sources: Moby tag `v28.0.4`, `profiles/seccomp/default.json` and
`profiles/apparmor/template.go`. Their Apache-2.0 license is included in
`security/LICENSE.moby`. Do not replace these with an unconfined policy.

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
The Actions entry workflow runs on GitHub-hosted Ubuntu 24.04 for pushes to
`feat/containerize-web2png`, `feat/publish-ghcr`, `master`, and for pull requests.
Both job paths call the same local reusable build/test workflow. Feature/PR jobs
have only `contents: read`, never authenticate to GHCR and never publish. Only
upstream `maniekes/web2png` master pushes select the job with `packages: write`.
Checkout stays pinned to the previously verified commit and does not persist
credentials. AppArmor cleanup runs even after test failures.

After all checks and cleanup succeed, that master job logs into GHCR using the
GitHub-provided `GITHUB_TOKEN` via stdin, tags the **same local image ID** tested as
`web2png:ci`, and pushes `sha-<full-commit-SHA>` followed by `latest`. There is no
second build, artifact transfer, PAT, additional third-party action, self-hosted
runner or production deployment. Source/revision OCI labels identify the build.
Master runs are serialized without cancellation; a stale revision is refused
before publication. A run that already published its SHA tag refuses to overwrite
it. If only the SHA push succeeded, recovery of `latest` needs owner review; do not
silently rebuild/replace that SHA. GHCR tags are not registry-enforced immutable:
use a manifest digest for a strict content pin. Remote manifest reads in CI use
credentials and are **not evidence of public availability**.

The existing release/npm workflow is untouched; no release is created here.

### First publication is not public visibility

1. Review the PR and its real container CI, then merge. The first successful
   upstream master run creates/pushes the package; before that, pulls may fail
   because the image does not exist. If a package with this name already exists,
   its owner must ensure this repository has Actions write access to it.
2. GitHub defaults a new container package to **private**, even for a public
   repository. The package owner must open the `web2png` package's **Package
   settings → Change visibility → Public** and confirm. Public visibility cannot
   subsequently be reverted to private. The workflow does not change visibility.
3. Verify anonymous access from a client without saved GHCR credentials, for both
   `latest` and the published SHA tag. On an authorized Docker client/host:

   ```sh
   # Replace the placeholder with the actual published commit SHA.
   sha=FULL_PUBLISHED_COMMIT_SHA
   anonymous_config=$(mktemp -d)
   docker --config "$anonymous_config" manifest inspect ghcr.io/maniekes/web2png:latest
   docker --config "$anonymous_config" manifest inspect "ghcr.io/maniekes/web2png:sha-$sha"
   docker --config "$anonymous_config" pull --platform linux/amd64 "ghcr.io/maniekes/web2png:sha-$sha"
   rm -rf "$anonymous_config"
   ```

   Record the successful anonymous pull and its digest before declaring the image
   public/ready. A successful authenticated push alone is insufficient.

While private, a deployment client needs a separately authorized login with
package read access (outside CI, GitHub supports a PAT classic with `read:packages`).
Keep it in the client's credential store, never the image, Compose file or git.
The intended public deployment requires **no registry token**. CI publication uses
only `GITHUB_TOKEN`, not a personal token.

For local HTTP/CLI tests without downloading Chrome:

```sh
PUPPETEER_SKIP_DOWNLOAD=true npm ci --no-audit --no-fund
npm test
node --test test/publish-policy.test.cjs
```

The publication policy test parses the workflow/Compose YAML using the already
locked `js-yaml` dependency. CI runs it in the built image without installing
extra packages. It checks trigger/permission gates, test-before-push ordering,
single-build tagging and pull-only Compose restrictions. Static tests do not
replace a real master publication or an anonymous registry pull.

These tests do **not** prove browser rendering or image compatibility.

## Compose example (not automatically deployed)

`compose.example.yaml` uses the published image; there is no `build:` and no local
source checkout or Node/npm install is needed on the server. After publication and
public-access verification, copy only these non-secret deployment files from the
same reviewed revision into a client deployment directory:

- `compose.example.yaml`
- `security/seccomp-chromium.json` (keep this relative path; Compose's Docker client
  must be able to read it)
- `security/apparmor-web2png` and `security/LICENSE.moby` where applicable.

On an AppArmor host, an authorized administrator must load the dedicated profile
on the Docker **host**, and enable `apparmor=web2png-browser` in the Compose file
as described above. Copying the policy alone does not load it. Keep the private
YAML config outside this directory/repository, readable by UID 1000. Do not put
credentials or real dashboard URLs in this public repository. Check the proposed
port and host sandbox compatibility before authorizing deployment. Then, from the
client deployment directory:

```sh
export WEB2PNG_CONFIG=/absolute/private/path/device-mappings.yaml
# Default is latest; prefer a specific published version for production.
export WEB2PNG_IMAGE=ghcr.io/maniekes/web2png:sha-FULL_PUBLISHED_COMMIT_SHA
docker compose -f compose.example.yaml config --quiet
docker compose -f compose.example.yaml pull
docker compose -f compose.example.yaml up -d --no-build
```

For a strict content pin, set `WEB2PNG_IMAGE` to
`ghcr.io/maniekes/web2png@sha256:RECORDED_MANIFEST_DIGEST` instead. Record the prior
working image reference and keep its matching policy files before upgrading.
Rollback is explicit: restore that prior `WEB2PNG_IMAGE` and matching policy files,
then repeat `pull` and `up -d --no-build`. Do not delete the old GHCR version until
the rollback window has passed. Neither a push to master nor a moved `latest` tag
updates a running server automatically.

The config is explicitly mounted read-only at `/config/device-mappings.yaml`;
Compose fails rather than creating a directory when the source is missing. It is
re-read on every screenshot request, so mounted configuration changes are visible.
The proposed bind is **127.0.0.1:13001 → container:3001**. Port 13001 is an example,
not a claim that it is available on the target host. Host port 3001 is deliberately
avoided. Loopback-only access is not a remote-device integration by itself; choose
any proxy/network integration separately. Compose uses the GHCR image and
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

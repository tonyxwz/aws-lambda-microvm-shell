# pi × AWS Lambda MicroVM shell

A [pi](https://pi.dev) extension that moves all of the agent's tools into a dedicated
[AWS Lambda MicroVM](https://aws.amazon.com/lambda/lambda-microvms/) (Firecracker). With it loaded, the agent
has **no access to your machine**. `bash`, `read`, `write`, `edit`, `ls`, `find`, `grep` and your own `!cmd`
all run in the MicroVM at `/workspace`.

```
pi (your laptop)  ──HTTPS + JWE token + per-VM secret──►  MicroVM endpoint :8080  ──►  server.js (exec / fs)
   └─ AWS SDK: RunMicrovm / GetMicrovm / Suspend / Resume / Terminate / CreateMicrovmAuthToken
```

## Setup

```bash
AWS_REGION=us-east-2 ./scripts/build-image.sh     # bucket + build role + MicroVM image (≈2 min)
(cd extension && npm install)
pi -e ./extension                                  # or symlink ./extension into ~/.pi/agent/extensions/
```

`build-image.sh` writes the image ARN into `~/.pi/agent/settings.json`:

```json
{ "extensionSettings": { "microvmArn": "arn:aws:lambda:us-east-2:123456789012:microvm-image:pi-agent-sandbox" } }
```

The image is Amazon Linux 2023 with the current **Node.js LTS** from nodejs.org (resolved at build time, or
pin it with the `NODE_VERSION` build arg in `image/Dockerfile`), plus python3, git, jq and the usual CLI tools.
The agent can install more with `dnf`, `pip` or `npm`.

## Sharing data

The agent can't read local files. Data moves only with your approval:

| | |
|---|---|
| `/mvm-upload <local> [remote]` | upload a file, or a directory (sent as tar.gz) |
| `/mvm-download <remote> [local]` | download a file or a directory |
| `request_upload` tool | the agent asks for a path and gives a reason; you approve, change the path, or decline |
| `request_download` tool | the agent offers results; you approve |

There is one exception: skill files listed in the system prompt (`<skills>`) are still read locally, read-only.

## Lifecycle

- One MicroVM per pi session. Its id and secret are saved in the session, so `pi --resume` reattaches to it.
- It suspends after `PI_MVM_IDLE_SECONDS` (900) without traffic and resumes automatically on the next tool call.
  Long commands send heartbeats, so they don't count as idle.
- On exit pi suspends it (`PI_MVM_ON_EXIT=suspend|terminate|keep`). It is terminated after
  `PI_MVM_SUSPENDED_SECONDS` suspended or `PI_MVM_MAX_DURATION_SECONDS` total (8h max).
- If the MicroVM has gone away, a new one is started and the agent is told that the earlier state is lost.
- `/mvm status|suspend|resume|terminate|new`

## Configuration

| Setting / env | Default |
|---|---|
| `extensionSettings.microvmArn` / `PI_MVM_IMAGE` (env wins) | `pi-agent-sandbox` in the current account |
| `AWS_REGION`, `AWS_PROFILE` (standard SDK credential chain) | |
| `PI_MVM_EGRESS` (`INTERNET_EGRESS`, a VPC connector ARN, or `none`) | `INTERNET_EGRESS` |
| `PI_MVM_EXECUTION_ROLE_ARN` (AWS permissions *inside* the VM) | none |

## Security notes

- Local environment variables are **not** forwarded. Only pi's `PI_*` session variables are.
- The MicroVM has no AWS credentials unless you set an execution role.
- Each request needs a Lambda JWE token, scoped to port 8080 and valid for 60 minutes, plus a 256-bit secret that
  is delivered through the `/run` hook payload. The hook port (9000) is never included in the tokens.
- Throughput through the endpoint is about 0.5 MB/s from a laptop. For large datasets, give the VM an
  execution role and pull from S3.

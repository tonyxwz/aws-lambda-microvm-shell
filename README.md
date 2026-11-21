# pi × AWS Lambda MicroVM shell

A [pi](https://pi.dev) extension that moves all of the agent's tools into a dedicated
[AWS Lambda MicroVM](https://aws.amazon.com/lambda/lambda-microvms/) (Firecracker). With it loaded, the agent
has **no access to your machine**. `bash`, `read`, `write`, `edit`, `ls`, `find`, `grep` and your own `!cmd`
all run in the MicroVM at `/workspace`.

```
pi (your laptop)  ──HTTPS + JWE token + per-VM secret──►  MicroVM endpoint :8080  ──►  image/server.js (exec / fs)
   └─ AWS SDK: RunMicrovm / GetMicrovm / Suspend / Resume / Terminate / CreateMicrovmAuthToken
```

## Install

```bash
pi install git:github.com/tonyxwz/aws-lambda-microvm-shell
# or try it once:  pi -e git:github.com/tonyxwz/aws-lambda-microvm-shell
```

Then, in pi:

```
/mvm init
```

`/mvm init` uses your normal AWS credentials (`AWS_PROFILE`, SSO, env vars, …). It shows what it will create
and asks before doing anything:

- an S3 bucket `pi-mvm-artifacts-<account>-<region>` for the code artifact
- an IAM role `PiMicrovmBuildRole` that Lambda assumes during the build (S3 read and CloudWatch logs only)
- a MicroVM image `pi-agent-sandbox`. Lambda builds the bundled [`image/Dockerfile`](image/Dockerfile) remotely
  (Amazon Linux 2023, the current Node.js LTS, python3, git, jq, …), so you don't need Docker.

The result is saved to `~/.pi/agent/settings.json`, and every later session launches from that image version:

```json
{
  "extensionSettings": {
    "microvmArn": "arn:aws:lambda:us-east-2:123456789012:microvm-image:pi-agent-sandbox",
    "microvmImage": { "version": "1.0", "region": "us-east-2", "architecture": "ARM_64", "memoryMiB": 2048, "nodeVersion": "lts", "builtAt": "…" }
  }
}
```

Options: `/mvm init [--region R] [--arch arm64|x86_64] [--memory 512|1024|2048|4096|8192] [--name N] [--node lts|vX.Y.Z]`.
Run it again to rebuild, for example to pick up a new Node.js LTS or base-image patches. Then run `/mvm new`
to switch the current session to the new image.

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

- One MicroVM per pi session. Its id and secret are saved in the session file, so `pi --resume` reattaches to it.
- It suspends after `PI_MVM_IDLE_SECONDS` (900) without traffic and resumes automatically on the next tool call.
  Long commands send heartbeats, so they don't count as idle.
- On exit pi suspends it (`PI_MVM_ON_EXIT=suspend|terminate|keep`). It is terminated after
  `PI_MVM_SUSPENDED_SECONDS` suspended or `PI_MVM_MAX_DURATION_SECONDS` total (8h max).
- If the MicroVM has gone away, a new one is started and the agent is told that the earlier state is lost.
- `/mvm status|suspend|resume|terminate|new`

## Configuration

| Setting / env | Default |
|---|---|
| `extensionSettings.microvmArn` / `microvmImage` | written by `/mvm init` |
| `PI_MVM_IMAGE` (image ARN; overrides the settings and uses the latest version) | |
| `PI_MVM_EGRESS` (`INTERNET_EGRESS`, a VPC connector ARN, or `none`) | `INTERNET_EGRESS` |
| `PI_MVM_EXECUTION_ROLE_ARN` (AWS permissions *inside* the VM) | none |
| `PI_MVM_IDLE_SECONDS` / `PI_MVM_SUSPENDED_SECONDS` / `PI_MVM_MAX_DURATION_SECONDS` | 900 / 28800 / 28800 |

## Security notes

- Local environment variables are **not** forwarded. Only pi's `PI_*` session variables are.
- The MicroVM has no AWS credentials unless you set an execution role.
- Each request needs a Lambda JWE token, scoped to port 8080 and valid for 60 minutes, plus a 256-bit secret that
  is delivered through the `/run` hook payload. The hook port (9000) is never included in the tokens.
- The MicroVM has outbound internet access by default. Set `PI_MVM_EGRESS=none` to remove it.
- Throughput through the endpoint is about 0.5 MB/s from a laptop. For large datasets, give the VM an
  execution role and pull from S3.

## Uninstall

```bash
pi remove git:github.com/tonyxwz/aws-lambda-microvm-shell
aws lambda-microvms delete-microvm-image --image-identifier <microvmArn>
aws iam delete-role-policy --role-name PiMicrovmBuildRole --policy-name pi-mvm-build
aws iam delete-role --role-name PiMicrovmBuildRole
aws s3 rb s3://pi-mvm-artifacts-<account>-<region> --force
```

## License

[Apache-2.0](LICENSE)

#!/usr/bin/env bash
# Build (or rebuild) the Lambda MicroVM image used by the pi lambda-microvm extension.
#
# Creates, if missing:
#   - S3 bucket   pi-mvm-artifacts-<account>-<region>   (code artifact)
#   - IAM role    PiMicrovmBuildRole                    (assumed by Lambda during image build)
#   - MicroVM image  $MVM_IMAGE (default: pi-agent-sandbox)
#
# Usage:  AWS_REGION=us-east-2 ./scripts/build-image.sh
# Env:    MVM_IMAGE, MVM_BUCKET, MVM_BUILD_ROLE, MVM_ARCH (ARM_64|X86_64), MVM_MEMORY_MIB (default 2048)
set -euo pipefail

cd "$(dirname "$0")/.."

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region || true)}}"
[[ -n "$REGION" ]] || { echo "Set AWS_REGION" >&2; exit 1; }
export AWS_REGION="$REGION" AWS_PAGER=""

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
IMAGE="${MVM_IMAGE:-pi-agent-sandbox}"
BUCKET="${MVM_BUCKET:-pi-mvm-artifacts-${ACCOUNT}-${REGION}}"
ROLE="${MVM_BUILD_ROLE:-PiMicrovmBuildRole}"
ARCH="${MVM_ARCH:-ARM_64}"
MEMORY="${MVM_MEMORY_MIB:-2048}"
BASE_IMAGE_ARN="arn:aws:lambda:${REGION}:aws:microvm-image:al2023-1"
IMAGE_ARN="arn:aws:lambda:${REGION}:${ACCOUNT}:microvm-image:${IMAGE}"

echo "==> account=$ACCOUNT region=$REGION image=$IMAGE bucket=$BUCKET role=$ROLE arch=$ARCH memory=${MEMORY}MiB"

# --- S3 bucket --------------------------------------------------------------
if ! aws s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
  echo "==> creating bucket $BUCKET"
  if [[ "$REGION" == "us-east-1" ]]; then
    aws s3api create-bucket --bucket "$BUCKET" >/dev/null
  else
    aws s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  fi
  aws s3api put-public-access-block --bucket "$BUCKET" \
    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
fi

# --- IAM build role ---------------------------------------------------------
if ! ROLE_ARN=$(aws iam get-role --role-name "$ROLE" --query Role.Arn --output text 2>/dev/null); then
  echo "==> creating IAM role $ROLE"
  ROLE_ARN=$(aws iam create-role --role-name "$ROLE" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
    --query Role.Arn --output text)
  NEW_ROLE=1
fi
aws iam put-role-policy --role-name "$ROLE" --policy-name pi-mvm-build --policy-document "$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect": "Allow", "Action": ["s3:GetObject"], "Resource": "arn:aws:s3:::${BUCKET}/*"},
    {"Effect": "Allow", "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], "Resource": "arn:aws:logs:*:*:*"}
  ]
}
EOF
)"
if [[ "${NEW_ROLE:-}" == 1 ]]; then echo "==> waiting for IAM propagation"; sleep 15; fi

# --- code artifact ----------------------------------------------------------
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
(cd image && zip -q -r "$TMP/artifact.zip" Dockerfile server.js)
HASH=$(shasum -a 256 "$TMP/artifact.zip" | cut -c1-12)
KEY="images/${IMAGE}/${HASH}.zip"
aws s3 cp --quiet "$TMP/artifact.zip" "s3://${BUCKET}/${KEY}"
echo "==> uploaded s3://${BUCKET}/${KEY}"

HOOKS='{"port":9000,"microvmHooks":{"run":"ENABLED","runTimeoutInSeconds":10},"microvmImageHooks":{"ready":"ENABLED","readyTimeoutInSeconds":300}}'
COMMON=(
  --code-artifact "uri=s3://${BUCKET}/${KEY}"
  --base-image-arn "$BASE_IMAGE_ARN"
  --build-role-arn "$ROLE_ARN"
  --cpu-configurations "architecture=${ARCH}"
  --resources "minimumMemoryInMiB=${MEMORY}"
  --hooks "$HOOKS"
  --egress-network-connectors "arn:aws:lambda:${REGION}:aws:network-connector:aws-network-connector:INTERNET_EGRESS"
  --description "pi agent sandbox (${HASH})"
)

# --- create or update image -------------------------------------------------
if aws lambda-microvms get-microvm-image --image-identifier "$IMAGE_ARN" >/dev/null 2>&1; then
  echo "==> updating image $IMAGE"
  aws lambda-microvms update-microvm-image --image-identifier "$IMAGE_ARN" "${COMMON[@]}" >/dev/null
else
  echo "==> creating image $IMAGE"
  aws lambda-microvms create-microvm-image --name "$IMAGE" "${COMMON[@]}" >/dev/null
fi

echo "==> waiting for build (logs: CloudWatch /aws/lambda-microvms/${IMAGE})"
while true; do
  STATE=$(aws lambda-microvms get-microvm-image --image-identifier "$IMAGE_ARN" --query state --output text)
  case "$STATE" in
    CREATED|UPDATED) break ;;
    *FAILED)
      aws lambda-microvms get-microvm-image --image-identifier "$IMAGE_ARN"
      echo "Build failed. See: aws logs tail /aws/lambda-microvms/${IMAGE} --since 1h" >&2
      exit 1 ;;
  esac
  printf '   %s %s\n' "$(date +%T)" "$STATE"
  sleep 15
done

aws lambda-microvms get-microvm-image --image-identifier "$IMAGE_ARN" --query '{name:name,arn:imageArn,state:state}'

# --- record the ARN in pi settings (extensionSettings.microvmArn) ------------
SETTINGS="${PI_SETTINGS:-$HOME/.pi/agent/settings.json}"
if [[ "${MVM_SKIP_SETTINGS:-}" != 1 ]]; then
  mkdir -p "$(dirname "$SETTINGS")"
  SETTINGS="$SETTINGS" ARN="$IMAGE_ARN" node -e '
    const fs = require("fs"); const f = process.env.SETTINGS;
    const s = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
    s.extensionSettings = { ...(s.extensionSettings || {}), microvmArn: process.env.ARN };
    fs.writeFileSync(f, JSON.stringify(s, null, 2) + "\n");'
  echo "==> wrote extensionSettings.microvmArn to $SETTINGS"
fi
echo "==> done. Start pi with:  pi -e $(pwd)/extension"

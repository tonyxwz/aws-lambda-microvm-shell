/**
 * `/mvm init`: provision the MicroVM image in the user's AWS account (remote build by Lambda).
 *
 *   1. S3 bucket for the code artifact + IAM build role (S3 read, CloudWatch logs)
 *   2. zip the bundled image/ folder (Dockerfile + server.js) and upload it to S3
 *   3. CreateMicrovmImage / UpdateMicrovmImage; Lambda runs the Dockerfile and snapshots the VM
 *   4. save the result to ~/.pi/agent/settings.json:
 *        extensionSettings.microvmArn    image ARN
 *        extensionSettings.microvmImage  { version, region, architecture, memoryMiB, nodeVersion, builtAt }
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { CreateRoleCommand, GetRoleCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import {
	CreateMicrovmImageCommand,
	GetMicrovmImageCommand,
	LambdaMicrovmsClient,
	UpdateMicrovmImageCommand,
} from "@aws-sdk/client-lambda-microvms";
import {
	CreateBucketCommand,
	HeadBucketCommand,
	PutObjectCommand,
	PutPublicAccessBlockCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";

/** image/ ships inside the npm package next to extension/. */
export const IMAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "image");
const IMAGE_FILES = ["Dockerfile", "server.js"];

export interface InitOptions {
	region?: string;
	name: string;
	arch: "ARM_64" | "X86_64";
	memoryMiB: number;
	nodeVersion: string;
}

export interface InitPlan extends InitOptions {
	region: string;
	account: string;
	bucket: string;
	roleName: string;
	imageArn: string;
}

/** Saved under extensionSettings.microvmImage. */
export interface SavedImage {
	version?: string;
	region: string;
	architecture: "ARM_64" | "X86_64";
	memoryMiB: number;
	nodeVersion: string;
	builtAt: string;
}

export interface InitResult {
	imageArn: string;
	image: SavedImage;
}

export interface InitIO {
	step(text: string): void;
	signal?: AbortSignal;
}

export const INIT_USAGE =
	"/mvm init [--region R] [--arch arm64|x86_64] [--memory 512|1024|2048|4096|8192] [--name N] [--node lts|vX.Y.Z]";

export function parseInitArgs(args: string[]): InitOptions {
	const opts: InitOptions = { name: "pi-agent-sandbox", arch: "ARM_64", memoryMiB: 2048, nodeVersion: "lts" };
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		const val = () => {
			const v = args[++i];
			if (!v) throw new Error(`${a} needs a value`);
			return v;
		};
		if (a === "--region") opts.region = val();
		else if (a === "--name") opts.name = val();
		else if (a === "--memory") opts.memoryMiB = Number(val());
		else if (a === "--node") opts.nodeVersion = val();
		else if (a === "--arch") {
			const v = val().toLowerCase();
			if (["arm64", "arm_64", "aarch64"].includes(v)) opts.arch = "ARM_64";
			else if (["x86_64", "x64", "amd64"].includes(v)) opts.arch = "X86_64";
			else throw new Error(`unknown --arch ${v} (arm64 | x86_64)`);
		} else throw new Error(`unknown option ${a}\nUsage: ${INIT_USAGE}`);
	}
	if (!/^[a-zA-Z0-9_-]{1,64}$/.test(opts.name)) throw new Error("--name must match [a-zA-Z0-9_-]{1,64}");
	if (![512, 1024, 2048, 4096, 8192].includes(opts.memoryMiB)) throw new Error("--memory must be 512, 1024, 2048, 4096 or 8192");
	if (!/^(lts|v\d+\.\d+\.\d+)$/.test(opts.nodeVersion)) throw new Error("--node must be lts or vX.Y.Z");
	return opts;
}

// ---------------------------------------------------------------------------------------------
// minimal zip writer (deflate), enough for the code artifact
// ---------------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(buf: Buffer): number {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

export function createZip(files: Array<{ name: string; data: Buffer }>): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const f of files) {
		const name = Buffer.from(f.name);
		const comp = deflateRawSync(f.data);
		const crc = crc32(f.data);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4); // version needed
		local.writeUInt16LE(8, 8); // deflate
		local.writeUInt16LE(0x21, 12); // date 1980-01-01
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(comp.length, 18);
		local.writeUInt32LE(f.data.length, 22);
		local.writeUInt16LE(name.length, 26);
		locals.push(local, name, comp);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(0x0314, 4); // made by: unix
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(8, 10);
		central.writeUInt16LE(0x21, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(comp.length, 20);
		central.writeUInt32LE(f.data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file 0644
		central.writeUInt32LE(offset, 42);
		centrals.push(central, name);
		offset += 30 + name.length + comp.length;
	}
	const centralSize = centrals.reduce((n, b) => n + b.length, 0);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(files.length, 8);
	end.writeUInt16LE(files.length, 10);
	end.writeUInt32LE(centralSize, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, ...centrals, end]);
}

// ---------------------------------------------------------------------------------------------
// plan + execute
// ---------------------------------------------------------------------------------------------

const isNotFound = (err: unknown) => {
	const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
	return (
		["NotFound", "NoSuchEntity", "NoSuchEntityException", "ResourceNotFoundException", "NoSuchBucket"].includes(e?.name ?? "") ||
		e?.$metadata?.httpStatusCode === 404
	);
};

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		if (signal?.aborted) return reject(new Error("aborted"));
		const t = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => (clearTimeout(t), reject(new Error("aborted"))), { once: true });
	});

export async function planInit(opts: InitOptions): Promise<InitPlan> {
	const sts = new STSClient(opts.region ? { region: opts.region } : {});
	const region = opts.region ?? (await sts.config.region().catch(() => undefined));
	if (!region) throw new Error("No AWS region configured. Use /mvm init --region <region> or set AWS_REGION.");
	const { Account } = await sts.send(new GetCallerIdentityCommand({}));
	return {
		...opts,
		region,
		account: Account!,
		bucket: `pi-mvm-artifacts-${Account}-${region}`,
		roleName: "PiMicrovmBuildRole",
		imageArn: `arn:aws:lambda:${region}:${Account}:microvm-image:${opts.name}`,
	};
}

export function describePlan(p: InitPlan): string {
	return [
		`AWS account ${p.account}, region ${p.region}. Creates or reuses:`,
		`• S3 bucket     ${p.bucket} (code artifact)`,
		`• IAM role      ${p.roleName} (assumed by Lambda during the image build)`,
		`• MicroVM image ${p.name}: ${p.arch}, ${p.memoryMiB} MiB baseline, Node.js ${p.nodeVersion}`,
		"",
		"Lambda builds the bundled Dockerfile remotely (about 2 minutes). The result is saved to",
		"~/.pi/agent/settings.json (extensionSettings.microvmArn / microvmImage).",
	].join("\n");
}

async function ensureBucket(s3: S3Client, p: InitPlan, io: InitIO) {
	try {
		await s3.send(new HeadBucketCommand({ Bucket: p.bucket, ExpectedBucketOwner: p.account }));
		return;
	} catch (err) {
		if (!isNotFound(err)) throw err;
	}
	io.step(`creating S3 bucket ${p.bucket}`);
	await s3.send(
		new CreateBucketCommand({
			Bucket: p.bucket,
			CreateBucketConfiguration: p.region === "us-east-1" ? undefined : { LocationConstraint: p.region as never },
		}),
	);
	await s3.send(
		new PutPublicAccessBlockCommand({
			Bucket: p.bucket,
			PublicAccessBlockConfiguration: {
				BlockPublicAcls: true,
				IgnorePublicAcls: true,
				BlockPublicPolicy: true,
				RestrictPublicBuckets: true,
			},
		}),
	);
}

async function ensureRole(iam: IAMClient, p: InitPlan, io: InitIO): Promise<{ arn: string; created: boolean }> {
	let arn: string | undefined;
	let created = false;
	try {
		arn = (await iam.send(new GetRoleCommand({ RoleName: p.roleName }))).Role?.Arn;
	} catch (err) {
		if (!isNotFound(err)) throw err;
	}
	if (!arn) {
		io.step(`creating IAM role ${p.roleName}`);
		arn = (
			await iam.send(
				new CreateRoleCommand({
					RoleName: p.roleName,
					Description: "Assumed by AWS Lambda to build MicroVM images for the pi lambda-microvm extension",
					AssumeRolePolicyDocument: JSON.stringify({
						Version: "2012-10-17",
						Statement: [
							{
								Effect: "Allow",
								Principal: { Service: "lambda.amazonaws.com" },
								Action: "sts:AssumeRole",
							},
						],
					}),
				}),
			)
		).Role!.Arn!;
		created = true;
	}
	await iam.send(
		new PutRolePolicyCommand({
			RoleName: p.roleName,
			PolicyName: "pi-mvm-build",
			PolicyDocument: JSON.stringify({
				Version: "2012-10-17",
				Statement: [
					{ Effect: "Allow", Action: ["s3:GetObject"], Resource: `arn:aws:s3:::${p.bucket}/*` },
					{
						Effect: "Allow",
						Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
						Resource: `arn:aws:logs:${p.region}:${p.account}:log-group:/aws/lambda-microvms/*`,
					},
				],
			}),
		}),
	);
	return { arn, created };
}

async function buildLogTail(p: InitPlan, since: number): Promise<string> {
	try {
		const logs = new CloudWatchLogsClient({ region: p.region });
		const res = await logs.send(
			new FilterLogEventsCommand({ logGroupName: `/aws/lambda-microvms/${p.name}`, startTime: since, limit: 10000 }),
		);
		return (res.events ?? [])
			.map((e) => e.message?.trim() ?? "")
			.filter(Boolean)
			.slice(-25)
			.join("\n");
	} catch {
		return "";
	}
}

export async function executeInit(p: InitPlan, io: InitIO): Promise<InitResult> {
	const s3 = new S3Client({ region: p.region });
	const iam = new IAMClient({ region: p.region });
	const mvms = new LambdaMicrovmsClient({ region: p.region });
	const started = Date.now();

	io.step("checking S3 bucket");
	await ensureBucket(s3, p, io);
	io.step("checking IAM build role");
	const role = await ensureRole(iam, p, io);

	io.step("uploading code artifact");
	const files = await Promise.all(
		IMAGE_FILES.map(async (name) => {
			let data = await fs.readFile(path.join(IMAGE_DIR, name));
			if (name === "Dockerfile") {
				data = Buffer.from(data.toString("utf8").replace(/^ARG NODE_VERSION=.*$/m, `ARG NODE_VERSION=${p.nodeVersion}`));
			}
			return { name, data };
		}),
	);
	const key = `images/${p.name}/${Date.now()}-${randomBytes(3).toString("hex")}.zip`;
	await s3.send(
		new PutObjectCommand({ Bucket: p.bucket, Key: key, Body: createZip(files), ExpectedBucketOwner: p.account }),
	);

	const input = {
		codeArtifact: { uri: `s3://${p.bucket}/${key}` },
		baseImageArn: `arn:aws:lambda:${p.region}:aws:microvm-image:al2023-1`,
		buildRoleArn: role.arn,
		cpuConfigurations: [{ architecture: p.arch }],
		resources: [{ minimumMemoryInMiB: p.memoryMiB }],
		hooks: {
			port: 9000,
			microvmHooks: { run: "ENABLED" as const, runTimeoutInSeconds: 10 },
			microvmImageHooks: { ready: "ENABLED" as const, readyTimeoutInSeconds: 300 },
		},
		// egress during the build: dnf + nodejs.org downloads
		egressNetworkConnectors: [`arn:aws:lambda:${p.region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`],
		description: `pi agent sandbox (Node.js ${p.nodeVersion})`,
	};

	let exists = true;
	try {
		await mvms.send(new GetMicrovmImageCommand({ imageIdentifier: p.imageArn }));
	} catch (err) {
		if (!isNotFound(err)) throw err;
		exists = false;
	}
	// A freshly created IAM role takes a few seconds to become assumable.
	for (let attempt = 0; ; attempt++) {
		try {
			io.step(`${exists ? "updating" : "creating"} MicroVM image ${p.name}`);
			if (exists) await mvms.send(new UpdateMicrovmImageCommand({ imageIdentifier: p.imageArn, ...input }));
			else await mvms.send(new CreateMicrovmImageCommand({ name: p.name, ...input }));
			break;
		} catch (err) {
			const retry = role.created && attempt < 6 && (err as { name?: string }).name === "ValidationException";
			if (!retry) throw err;
			io.step("waiting for IAM role propagation");
			await sleep(10_000, io.signal);
		}
	}

	const buildStart = Date.now();
	for (;;) {
		await sleep(10_000, io.signal);
		const img = await mvms.send(new GetMicrovmImageCommand({ imageIdentifier: p.imageArn }));
		if (img.state === "CREATED" || img.state === "UPDATED") {
			return {
				imageArn: p.imageArn,
				image: {
					version: img.latestActiveImageVersion,
					region: p.region,
					architecture: p.arch,
					memoryMiB: p.memoryMiB,
					nodeVersion: p.nodeVersion,
					builtAt: new Date().toISOString(),
				},
			};
		}
		if (img.state?.endsWith("FAILED")) {
			const tail = await buildLogTail(p, started);
			throw new Error(
				`MicroVM image build ${img.state}` +
					(tail ? `\n\nBuild log (CloudWatch /aws/lambda-microvms/${p.name}):\n${tail}` : ""),
			);
		}
		io.step(`Lambda is building the image (${img.state}, ${Math.round((Date.now() - buildStart) / 1000)}s)`);
	}
}

/** Persist the init result in the global pi settings file (other settings are preserved). */
export async function saveInitResult(settingsFile: string, result: InitResult): Promise<void> {
	let settings: Record<string, unknown> = {};
	let mode = 0o600;
	try {
		settings = JSON.parse(await fs.readFile(settingsFile, "utf8"));
		mode = (await fs.stat(settingsFile)).mode & 0o777;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	const ext = (settings.extensionSettings as Record<string, unknown> | undefined) ?? {};
	settings.extensionSettings = { ...ext, microvmArn: result.imageArn, microvmImage: result.image };
	await fs.mkdir(path.dirname(settingsFile), { recursive: true });
	const tmp = `${settingsFile}.${process.pid}.tmp`;
	await fs.writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode });
	await fs.rename(tmp, settingsFile);
}

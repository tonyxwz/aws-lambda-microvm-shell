/**
 * Lambda MicroVM client: lifecycle via the AWS SDK, data plane via the MicroVM HTTPS endpoint
 * talking to image/server.js inside the VM.
 */

import { randomBytes } from "node:crypto";
import {
	CreateMicrovmAuthTokenCommand,
	GetMicrovmCommand,
	type GetMicrovmResponse,
	LambdaMicrovmsClient,
	ResumeMicrovmCommand,
	RunMicrovmCommand,
	SuspendMicrovmCommand,
	TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";

export interface MicrovmConfig {
	region?: string;
	/** MicroVM image name or ARN. Empty = not set up. */
	image: string;
	/** Pin RunMicrovm to this image version (default: latest active). */
	imageVersion?: string;
	maxIdleSeconds: number;
	suspendedSeconds: number;
	maxDurationSeconds: number;
	/** Egress connector name or ARN. "INTERNET_EGRESS" by default; "none" disables egress. */
	egress: string;
	executionRoleArn?: string;
}

export interface MicrovmIdentity {
	microvmId: string;
	secret: string;
}

export type MicrovmEvent =
	| { type: "status"; text: string }
	| { type: "launched"; id: string; replaced?: string; reason?: string };

const API_PORT = 8080;
const TOKEN_MINUTES = 60;
const TOKEN_REFRESH_MS = 5 * 60_000;
export const UPLOAD_CHUNK = 1024 * 1024;
export const UPLOAD_PARALLEL = 4;

export class HttpError extends Error {
	status: number;
	code?: string;
	constructor(status: number, message: string, code?: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		if (signal?.aborted) return reject(new Error("aborted"));
		const t = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(t);
				reject(new Error("aborted"));
			},
			{ once: true },
		);
	});

function isNotFound(err: unknown): boolean {
	const name = (err as { name?: string })?.name ?? "";
	return name === "ResourceNotFoundException" || name === "NotFoundException";
}

export class Microvm {
	client: LambdaMicrovmsClient;
	private region?: string;
	private identity?: MicrovmIdentity;
	private endpoint?: string;
	private token?: { value: string; expires: number };
	private ensuring?: Promise<void>;
	private verifiedAt = 0;
	/** One-shot notice for the model (e.g. the VM was replaced and state was lost). */
	pendingNotice?: string;
	private cfg: MicrovmConfig;
	private onEvent: (e: MicrovmEvent) => void;

	constructor(cfg: MicrovmConfig, onEvent: (e: MicrovmEvent) => void = () => {}) {
		this.cfg = cfg;
		this.onEvent = onEvent;
		this.client = new LambdaMicrovmsClient(cfg.region ? { region: cfg.region } : {});
	}

	get id(): string | undefined {
		return this.identity?.microvmId;
	}

	/** MicroVM image name or ARN used for future launches. */
	get image(): string {
		return this.cfg.image;
	}

	get imageVersion(): string | undefined {
		return this.cfg.imageVersion;
	}

	/** Change the image used for future launches. The region defaults to the one in the image ARN. */
	configure(image: string, imageVersion?: string, region?: string) {
		this.cfg.image = image;
		this.cfg.imageVersion = imageVersion;
		const r = region ?? (image.startsWith("arn:") ? image.split(":")[3] : undefined) ?? this.cfg.region;
		if (r && r !== this.cfg.region) {
			this.cfg.region = r;
			this.region = undefined;
			this.client = new LambdaMicrovmsClient({ region: r });
		}
	}

	get identityInfo(): MicrovmIdentity | undefined {
		return this.identity;
	}

	get url(): string | undefined {
		return this.endpoint ? `https://${this.endpoint}` : undefined;
	}

	/** Reattach to a previously launched MicroVM (e.g. when a pi session is resumed). */
	attach(identity: MicrovmIdentity) {
		this.identity = identity;
		this.endpoint = undefined;
		this.token = undefined;
		this.verifiedAt = 0;
	}

	private async resolveRegion(): Promise<string> {
		if (!this.region) this.region = await this.client.config.region();
		return this.region;
	}

	private async imageArn(): Promise<string> {
		if (this.cfg.image.startsWith("arn:")) return this.cfg.image;
		const region = await this.resolveRegion();
		const sts = new STSClient({ region });
		const { Account } = await sts.send(new GetCallerIdentityCommand({}));
		return `arn:aws:lambda:${region}:${Account}:microvm-image:${this.cfg.image}`;
	}

	private async connectorArn(name: string): Promise<string> {
		if (name.startsWith("arn:")) return name;
		return `arn:aws:lambda:${await this.resolveRegion()}:aws:network-connector:aws-network-connector:${name}`;
	}

	async describe(): Promise<GetMicrovmResponse | undefined> {
		if (!this.identity) return undefined;
		try {
			return await this.client.send(new GetMicrovmCommand({ microvmIdentifier: this.identity.microvmId }));
		} catch (err) {
			if (isNotFound(err)) return undefined;
			throw err;
		}
	}

	private async launch(signal?: AbortSignal, reason?: string): Promise<void> {
		if (!this.cfg.image) {
			throw new Error(
				"Lambda MicroVM is not set up: no MicroVM image configured. Ask the user to run /mvm init (or set extensionSettings.microvmArn).",
			);
		}
		const replaced = this.identity?.microvmId;
		this.onEvent({ type: "status", text: "launching MicroVM…" });
		const secret = randomBytes(32).toString("base64url");
		const egress =
			this.cfg.egress.toLowerCase() === "none" ? [] : [await this.connectorArn(this.cfg.egress)];
		const res = await this.client.send(
			new RunMicrovmCommand({
				imageIdentifier: await this.imageArn(),
				imageVersion: this.cfg.imageVersion,
				ingressNetworkConnectors: [await this.connectorArn("HTTP_INGRESS")],
				egressNetworkConnectors: egress,
				idlePolicy: {
					autoResumeEnabled: true,
					maxIdleDurationSeconds: this.cfg.maxIdleSeconds,
					suspendedDurationSeconds: this.cfg.suspendedSeconds,
				},
				maximumDurationInSeconds: this.cfg.maxDurationSeconds,
				executionRoleArn: this.cfg.executionRoleArn,
				runHookPayload: JSON.stringify({ secret }),
			}),
			{ abortSignal: signal },
		);
		this.identity = { microvmId: res.microvmId!, secret };
		this.endpoint = res.endpoint;
		this.token = undefined;
		await this.waitRunning(signal);
		this.onEvent({ type: "launched", id: res.microvmId!, replaced, reason });
		if (replaced) {
			this.pendingNotice = `[lambda-microvm: the previous MicroVM (${replaced}) is gone (${reason ?? "terminated"}); a fresh MicroVM ${res.microvmId} was started. Files and processes from before are lost.]`;
		}
	}

	private async waitRunning(signal?: AbortSignal): Promise<void> {
		const deadline = Date.now() + 180_000;
		let resumed = false;
		while (Date.now() < deadline) {
			const d = await this.describe();
			if (!d) throw new Error("MicroVM disappeared while starting");
			this.endpoint = d.endpoint ?? this.endpoint;
			switch (d.state) {
				case "RUNNING":
					this.verifiedAt = Date.now();
					this.onEvent({ type: "status", text: "running" });
					return;
				case "SUSPENDED":
					if (!resumed) {
						this.onEvent({ type: "status", text: "resuming MicroVM…" });
						await this.client.send(new ResumeMicrovmCommand({ microvmIdentifier: this.identity!.microvmId }));
						resumed = true;
					}
					break;
				case "TERMINATING":
				case "TERMINATED":
					throw new Error(`MicroVM ${d.state}: ${d.stateReason ?? ""}`);
				default: // PENDING, SUSPENDING
					this.onEvent({ type: "status", text: `${d.state?.toLowerCase()}…` });
			}
			await sleep(1000, signal);
		}
		throw new Error("Timed out waiting for MicroVM to reach RUNNING");
	}

	/** Make sure we have a RUNNING MicroVM (launching / resuming / replacing as needed). */
	ensure(signal?: AbortSignal, force = false): Promise<void> {
		if (!force && this.identity && this.endpoint && Date.now() - this.verifiedAt < 60_000) return Promise.resolve();
		if (!this.ensuring) {
			this.ensuring = (async () => {
				if (!this.identity) return this.launch(signal);
				const d = await this.describe();
				if (!d || d.state === "TERMINATED" || d.state === "TERMINATING") {
					return this.launch(signal, d ? `${d.state}${d.stateReason ? `: ${d.stateReason}` : ""}` : "not found");
				}
				this.endpoint = d.endpoint;
				if (d.state === "RUNNING") {
					this.verifiedAt = Date.now();
					return;
				}
				await this.waitRunning(signal);
			})().finally(() => {
				this.ensuring = undefined;
			});
		}
		return this.ensuring;
	}

	private async authToken(): Promise<string> {
		if (this.token && this.token.expires - Date.now() > TOKEN_REFRESH_MS) return this.token.value;
		const res = await this.client.send(
			new CreateMicrovmAuthTokenCommand({
				microvmIdentifier: this.identity!.microvmId,
				expirationInMinutes: TOKEN_MINUTES,
				allowedPorts: [{ port: API_PORT }],
			}),
		);
		const value = res.authToken?.["X-aws-proxy-auth"];
		if (!value) throw new Error("CreateMicrovmAuthToken returned no X-aws-proxy-auth token");
		this.token = { value, expires: Date.now() + TOKEN_MINUTES * 60_000 };
		return value;
	}

	/** Authenticated request to the in-VM agent. Retries once after re-verifying the VM on transport/proxy errors. */
	async request(
		path: string,
		init: {
			method?: string;
			body?: BodyInit;
			headers?: Record<string, string>;
			signal?: AbortSignal;
			/** false: only retry transport errors that certainly happened before the request was sent. */
			idempotent?: boolean;
		} = {},
	): Promise<Response> {
		for (let attempt = 0; ; attempt++) {
			await this.ensure(init.signal, attempt > 0);
			let res: Response;
			try {
				res = await fetch(`${this.url}${path}`, {
					method: init.method ?? "GET",
					body: init.body,
					signal: init.signal,
					headers: {
						"X-aws-proxy-auth": await this.authToken(),
						"X-aws-proxy-port": String(API_PORT),
						"x-mvm-secret": this.identity!.secret,
						...init.headers,
					},
				});
			} catch (err) {
				const code = (err as { cause?: { code?: string } })?.cause?.code ?? "";
				const beforeSend = ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT"].includes(code);
				if (init.signal?.aborted || attempt >= 2 || (init.idempotent === false && !beforeSend)) throw err;
				await sleep(1000 * (attempt + 1), init.signal);
				continue;
			}
			// 401/403 from the proxy: token problem; 502/503/504: resume failed or app not ready.
			const retryable = [401, 403, 502, 503, 504].includes(res.status);
			if (res.ok || !retryable || attempt >= 2) {
				if (!res.ok) {
					let msg = `${res.status} ${res.statusText}`;
					let code: string | undefined;
					try {
						const body = (await res.json()) as { error?: string; code?: string };
						msg = body.error ?? msg;
						code = body.code;
					} catch {}
					throw new HttpError(res.status, msg, code);
				}
				return res;
			}
			await res.body?.cancel().catch(() => {});
			if (res.status === 401 || res.status === 403) this.token = undefined;
			await sleep(1000 * (attempt + 1), init.signal);
		}
	}

	// --- data plane ------------------------------------------------------------

	async exec(
		command: string,
		cwd: string,
		opts: { onData?: (b: Buffer) => void; signal?: AbortSignal; timeout?: number; env?: Record<string, string> } = {},
	): Promise<{ exitCode: number | null }> {
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		let timedOut = false;
		const timer =
			opts.timeout && opts.timeout > 0
				? setTimeout(() => {
						timedOut = true;
						controller.abort();
					}, (opts.timeout + 5) * 1000)
				: undefined;
		try {
			const res = await this.request("/exec", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ command, cwd, env: opts.env, timeoutSec: opts.timeout }),
				signal: controller.signal,
				idempotent: false,
			});
			const reader = res.body!.getReader();
			const decoder = new TextDecoder();
			let buf = "";
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				let idx: number;
				while ((idx = buf.indexOf("\n\n")) >= 0) {
					const frame = buf.slice(0, idx);
					buf = buf.slice(idx + 2);
					if (!frame.startsWith("data: ")) continue;
					const msg = JSON.parse(frame.slice(6)) as {
						o?: string;
						exit?: number | null;
						error?: string;
						timeout?: boolean;
					};
					if (msg.o) opts.onData?.(Buffer.from(msg.o, "base64"));
					else if (msg.timeout) throw new Error(`timeout:${opts.timeout}`);
					else if (msg.error) throw new Error(msg.error);
					else if ("exit" in msg) return { exitCode: msg.exit ?? null };
				}
			}
			throw new Error("MicroVM connection closed before the command finished");
		} catch (err) {
			if (opts.signal?.aborted) throw new Error("aborted");
			if (timedOut) throw new Error(`timeout:${opts.timeout}`);
			throw err;
		} finally {
			if (timer) clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
		}
	}

	/** Run a command and collect its output (merged stdout/stderr). */
	async run(command: string, cwd = "/", signal?: AbortSignal): Promise<{ exitCode: number | null; output: string }> {
		const chunks: Buffer[] = [];
		const { exitCode } = await this.exec(command, cwd, { onData: (b) => chunks.push(b), signal });
		return { exitCode, output: Buffer.concat(chunks).toString("utf8") };
	}

	async readFile(path: string, signal?: AbortSignal): Promise<Buffer> {
		const res = await this.request(`/fs/read?path=${encodeURIComponent(path)}`, { signal });
		return Buffer.from(await res.arrayBuffer());
	}

	async writeFile(path: string, data: Buffer | string, offset = 0, signal?: AbortSignal): Promise<void> {
		await this.request(`/fs/write?path=${encodeURIComponent(path)}&offset=${offset}`, {
			method: "POST",
			body: typeof data === "string" ? data : new Uint8Array(data),
			headers: { "content-type": "application/octet-stream" },
			signal,
		});
	}

	async stat(path: string): Promise<{ type: "dir" | "file" | "other"; size: number; mtimeMs: number; writable: boolean }> {
		const res = await this.request(`/fs/stat?path=${encodeURIComponent(path)}`);
		return (await res.json()) as never;
	}

	async exists(path: string): Promise<boolean> {
		try {
			await this.stat(path);
			return true;
		} catch (err) {
			if (err instanceof HttpError && err.status === 404) return false;
			throw err;
		}
	}

	async readdir(path: string): Promise<string[]> {
		const res = await this.request(`/fs/readdir?path=${encodeURIComponent(path)}`);
		return (await res.json()) as string[];
	}

	async mkdir(path: string): Promise<void> {
		await this.request(`/fs/mkdir?path=${encodeURIComponent(path)}`, { method: "POST" });
	}

	async untar(src: string, dest: string): Promise<void> {
		await this.request(`/fs/untar?src=${encodeURIComponent(src)}&dest=${encodeURIComponent(dest)}&remove=1`, {
			method: "POST",
		});
	}

	async tarStream(path: string, signal?: AbortSignal): Promise<Response> {
		return this.request(`/fs/tar?path=${encodeURIComponent(path)}`, { signal });
	}

	// --- lifecycle ---------------------------------------------------------------

	async suspend(): Promise<void> {
		if (!this.identity) return;
		await this.client.send(new SuspendMicrovmCommand({ microvmIdentifier: this.identity.microvmId }));
		this.verifiedAt = 0;
	}

	async resume(): Promise<void> {
		await this.ensure(undefined, true);
	}

	async terminate(): Promise<void> {
		if (!this.identity) return;
		try {
			await this.client.send(new TerminateMicrovmCommand({ microvmIdentifier: this.identity.microvmId }));
		} catch (err) {
			if (!isNotFound(err)) throw err;
		}
		this.identity = undefined;
		this.endpoint = undefined;
		this.token = undefined;
		this.verifiedAt = 0;
	}
}

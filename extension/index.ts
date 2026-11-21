/**
 * pi extension: Lambda MicroVM shell
 *
 * Replaces pi's built-in tools (bash, read, write, edit, ls, find, grep) and user `!` commands with
 * implementations that run inside a dedicated AWS Lambda MicroVM (Firecracker). The agent has no
 * access to the local machine; local data reaches the VM only when the user shares it:
 *
 *   /mvm-upload <local> [remote]     user uploads a file or directory into the MicroVM
 *   /mvm-download <remote> [local]   user downloads a file or directory from the MicroVM
 *   request_upload / request_download tools: the agent asks, the user approves in the UI
 *   /mvm [status|suspend|resume|terminate|new]
 *
 * Config: settings.json `extensionSettings.microvmArn` (MicroVM image ARN, written by scripts/build-image.sh).
 * Env overrides: PI_MVM_IMAGE, AWS_REGION/AWS_PROFILE, PI_MVM_IDLE_SECONDS, PI_MVM_SUSPENDED_SECONDS,
 *   PI_MVM_MAX_DURATION_SECONDS, PI_MVM_EGRESS, PI_MVM_EXECUTION_ROLE_ARN, PI_MVM_ON_EXIT
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	type BashOperations,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	DEFAULT_MAX_BYTES,
	type EditOperations,
	type FindOperations,
	formatSize,
	type GrepToolDetails,
	type LsOperations,
	type ReadOperations,
	truncateHead,
	truncateLine,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { HttpError, Microvm, type MicrovmIdentity, UPLOAD_CHUNK, UPLOAD_PARALLEL } from "./microvm.ts";

const execFileP = promisify(execFile);

const REMOTE_CWD = "/workspace";
const ENTRY_TYPE = "lambda-microvm";
const STATUS_KEY = "mvm";

const env = process.env;
const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);
const ON_EXIT = (env.PI_MVM_ON_EXIT ?? "suspend") as "suspend" | "terminate" | "keep";

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const stripAt = (p: string) => (p.startsWith("@") ? p.slice(1) : p);
const toRemote = (p: string | undefined) => path.posix.resolve(REMOTE_CWD, stripAt((p ?? "").trim()) || ".");
const expandHome = (p: string) => (p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p);

function notFound(p: string): Error {
	return Object.assign(new Error(`ENOENT: no such file or directory '${p}'`), { code: "ENOENT" });
}

/** Wraps HttpError 404 into ENOENT-style errors the built-in tools understand. */
async function fsCall<T>(p: string, fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		if (err instanceof HttpError && err.status === 404) throw notFound(p);
		throw err;
	}
}

/** Same semantics as the built-in find/grep: a pattern with "/" matches the relative path, otherwise the basename. */
function matchesToolGlob(relativePath: string, pattern: string): boolean {
	const p = pattern.replace(/^(?:\.\/)+/, "");
	return p.includes("/")
		? path.posix.matchesGlob(relativePath, p)
		: path.posix.matchesGlob(path.posix.basename(relativePath), p);
}

/** Only forward pi's session variables to the VM, never the local process environment. */
function piEnv(e: NodeJS.ProcessEnv | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(e ?? {})) {
		if (k.startsWith("PI_") && typeof v === "string" && k !== "PI_SESSION_FILE") out[k] = v;
	}
	return out;
}

/** Make built-in tools resolve relative paths against the remote working directory. */
function remoteCtx<T extends { cwd: string }>(ctx: T): T {
	return new Proxy(ctx, {
		get(target, prop) {
			if (prop === "cwd") return REMOTE_CWD;
			const v = Reflect.get(target, prop, target);
			return typeof v === "function" ? v.bind(target) : v;
		},
	});
}

const DEFAULT_IMAGE = "pi-agent-sandbox";

/** Image ARN from settings.json: extensionSettings.microvmArn (or extensionSettings["pi-lambda-microvm"].microvmArn). */
function imageFromSettings(settings: unknown): string | undefined {
	const ext = (settings as { extensionSettings?: Record<string, unknown> })?.extensionSettings;
	const flat = ext?.microvmArn;
	const scoped = (ext?.["pi-lambda-microvm"] as { microvmArn?: unknown } | undefined)?.microvmArn;
	const v = typeof flat === "string" ? flat : typeof scoped === "string" ? scoped : undefined;
	return v?.trim() || undefined;
}

// ---------------------------------------------------------------------------------------------
// extension
// ---------------------------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const localCwd = process.cwd();
	let uiCtx: ExtensionContext | undefined;
	/** Local directories the read tool may still read (skill files listed in the system prompt). */
	const localReadRoots = new Set<string>();

	const mvm = new Microvm(
		{
			region: env.PI_MVM_REGION || env.AWS_REGION || env.AWS_DEFAULT_REGION,
			image: env.PI_MVM_IMAGE || DEFAULT_IMAGE, // replaced from settings on session_start
			maxIdleSeconds: num(env.PI_MVM_IDLE_SECONDS, 900),
			suspendedSeconds: num(env.PI_MVM_SUSPENDED_SECONDS, 8 * 3600),
			maxDurationSeconds: num(env.PI_MVM_MAX_DURATION_SECONDS, 8 * 3600),
			egress: env.PI_MVM_EGRESS || "INTERNET_EGRESS",
			executionRoleArn: env.PI_MVM_EXECUTION_ROLE_ARN || undefined,
		},
		(e) => {
			const ui = uiCtx?.ui;
			if (e.type === "status") {
				ui?.setStatus(STATUS_KEY, ui.theme.fg("accent", `MicroVM: ${e.text}`));
			} else {
				pi.appendEntry(ENTRY_TYPE, mvm.identityInfo);
				ui?.setStatus(STATUS_KEY, ui.theme.fg("accent", `MicroVM: ${e.id}`));
				if (e.replaced) ui?.notify(`MicroVM ${e.replaced} was ${e.reason}; started fresh ${e.id}`, "warning");
				else ui?.notify(`MicroVM ${e.id} is running (${REMOTE_CWD})`, "info");
			}
		},
	);

	// --- operations backed by the MicroVM ---------------------------------------------------

	const bashOps: BashOperations = {
		exec: (command, cwd, { onData, signal, timeout, env: e }) => {
			const inLocal = cwd === localCwd || cwd.startsWith(localCwd + path.sep);
			return mvm.exec(command, inLocal ? REMOTE_CWD : cwd, { onData, signal, timeout, env: piEnv(e) });
		},
	};

	const readOps: ReadOperations = {
		readFile: (p) => fsCall(p, () => mvm.readFile(p)),
		access: (p) => fsCall(p, () => mvm.stat(p)).then(() => undefined),
		detectImageMimeType: async (p) =>
			({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" })[
				path.posix.extname(p).toLowerCase()
			] ?? null,
	};

	const writeOps: WriteOperations = {
		writeFile: (p, content) => mvm.writeFile(p, content),
		mkdir: (d) => mvm.mkdir(d),
	};

	const editOps: EditOperations = {
		readFile: readOps.readFile,
		writeFile: writeOps.writeFile,
		access: async (p) => {
			const st = await fsCall(p, () => mvm.stat(p));
			if (!st.writable) throw Object.assign(new Error(`EACCES: permission denied '${p}'`), { code: "EACCES" });
		},
	};

	const lsOps: LsOperations = {
		exists: (p) => mvm.exists(p),
		stat: async (p) => {
			const st = await fsCall(p, () => mvm.stat(p));
			return { isDirectory: () => st.type === "dir" };
		},
		readdir: (p) => fsCall(p, () => mvm.readdir(p)),
	};

	const findOps: FindOperations = {
		exists: (p) => mvm.exists(p),
		glob: async (pattern, cwd, { limit }) => {
			const { output } = await mvm.run(
				"find . -mindepth 1 \\( -name .git -o -name node_modules \\) -prune -o -print 2>/dev/null | head -n 500000",
				cwd,
			);
			const results: string[] = [];
			for (const line of output.split("\n")) {
				if (!line) continue;
				const rel = line.replace(/^\.\//, "");
				if (matchesToolGlob(rel, pattern)) results.push(path.posix.join(cwd, rel));
				if (results.length >= limit) break;
			}
			return results;
		},
	};

	// --- tool registration -------------------------------------------------------------------

	const withNotice = <R extends { content: Array<{ type: string; text?: string }> }>(result: R): R => {
		const notice = mvm.pendingNotice;
		if (!notice) return result;
		mvm.pendingNotice = undefined;
		return { ...result, content: [{ type: "text", text: notice }, ...result.content] };
	};

	// biome-ignore lint/suspicious/noExplicitAny: generic wrapper over heterogeneous tool definitions
	function registerRemote(def: ToolDefinition<any, any, any>, extraGuidelines: string[] = []) {
		pi.registerTool({
			...def,
			promptGuidelines: [...(def.promptGuidelines ?? []), ...extraGuidelines],
			async execute(id, params, signal, onUpdate, ctx) {
				return withNotice(await def.execute(id, params, signal, onUpdate, remoteCtx(ctx)));
			},
		});
	}

	registerRemote(createBashToolDefinition(REMOTE_CWD, { operations: bashOps }), [
		"bash runs inside an isolated AWS Lambda MicroVM (Amazon Linux 2023, dnf available), not on the user's computer.",
	]);
	registerRemote(createWriteToolDefinition(REMOTE_CWD, { operations: writeOps }));
	registerRemote(createEditToolDefinition(REMOTE_CWD, { operations: editOps }));
	registerRemote(createLsToolDefinition(REMOTE_CWD, { operations: lsOps }));
	registerRemote(createFindToolDefinition(REMOTE_CWD, { operations: findOps }));

	// read: remote, except skill files the system prompt points at (read-only, local).
	const remoteRead = createReadToolDefinition(REMOTE_CWD, { operations: readOps });
	const localRead = createReadToolDefinition(localCwd);
	pi.registerTool({
		...remoteRead,
		async execute(id, params, signal, onUpdate, ctx) {
			const p = stripAt(params.path);
			if (path.isAbsolute(p)) {
				const real = await fs.realpath(p).catch(() => undefined);
				const allowed =
					real && [...localReadRoots].some((root) => real === root || real.startsWith(root + path.sep));
				if (allowed) return localRead.execute(id, { ...params, path: real }, signal, onUpdate, ctx);
			}
			return withNotice(await remoteRead.execute(id, params, signal, onUpdate, remoteCtx(ctx)));
		},
	});

	// grep: the built-in always runs local ripgrep, so implement it with GNU grep in the VM.
	const grepDef = createGrepToolDefinition(REMOTE_CWD);
	pi.registerTool({
		...grepDef,
		async execute(_id, params, signal) {
			const root = toRemote(params.path);
			const st = await fsCall(root, () => mvm.stat(root)).catch((err) => {
				throw err?.code === "ENOENT" ? new Error(`Path not found: ${root}`) : err;
			});
			const isDir = st.type === "dir";
			const limit = Math.max(1, Math.floor(params.limit ?? 100));
			const ctxLines = params.context && params.context > 0 ? Math.floor(params.context) : 0;
			const glob = params.glob?.replace(/^(?:\.\/)+/, "");
			const args = ["grep", "-r", "-n", "-H", "-I", "--null", "--color=never"];
			args.push("--exclude-dir=.git", "--exclude-dir=node_modules");
			if (params.ignoreCase) args.push("-i");
			args.push(params.literal ? "-F" : "-P");
			if (ctxLines) args.push(`-C${ctxLines}`);
			if (glob && !glob.includes("/")) args.push(`--include=${glob}`);
			args.push("-e", params.pattern, "--", isDir ? "." : path.posix.basename(root));
			const maxLines = glob?.includes("/") ? 1_000_000 : limit * (2 * ctxLines + 2) + 1;
			const cmd = `${args.map(shq).join(" ")} 2>&1 | head -n ${maxLines}`;
			const { output } = await mvm.run(cmd, isDir ? root : path.posix.dirname(root), signal);

			const out: string[] = [];
			const errors: string[] = [];
			let matches = 0;
			let limitReached = false;
			let linesTruncated = false;
			for (const line of output.split("\n")) {
				const nul = line.indexOf("\0");
				if (nul < 0) {
					if (line && line !== "--") errors.push(line);
					else if (line === "--" && out.length && ctxLines) out.push("--");
					continue;
				}
				const file = line.slice(0, nul).replace(/^\.\//, "");
				const m = /^(\d+)([:-])(.*)$/s.exec(line.slice(nul + 1));
				if (!m) continue;
				if (glob?.includes("/") && !matchesToolGlob(file, glob)) continue;
				const isMatch = m[2] === ":";
				if (isMatch && matches >= limit) {
					limitReached = true;
					break;
				}
				if (isMatch) matches++;
				const { text, wasTruncated } = truncateLine(m[3].replace(/\r/g, ""));
				if (wasTruncated) linesTruncated = true;
				out.push(`${file}${m[2]}${m[1]}${m[2]} ${text}`);
			}
			if (matches === 0) {
				if (errors.length) throw new Error(errors.join("\n"));
				return { content: [{ type: "text", text: "No matches found" }], details: undefined };
			}
			if (out[out.length - 1] === "--") out.pop();
			const truncation = truncateHead(out.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
			const details: GrepToolDetails = {};
			const notices: string[] = [];
			if (limitReached) {
				details.matchLimitReached = limit;
				notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`);
			}
			if (truncation.truncated) {
				details.truncation = truncation;
				notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
			}
			if (linesTruncated) {
				details.linesTruncated = true;
				notices.push("Some lines truncated. Use read tool to see full lines");
			}
			let text = truncation.content;
			if (notices.length) text += `\n\n[${notices.join(". ")}]`;
			return withNotice({
				content: [{ type: "text" as const, text }],
				details: Object.keys(details).length ? details : undefined,
			});
		},
	});

	// --- sharing: upload / download -----------------------------------------------------------

	async function uploadFile(local: string, remote: string, onProgress?: (done: number, total: number) => void) {
		const fh = await fs.open(local, "r");
		try {
			const { size } = await fh.stat();
			const readChunk = async (offset: number) => {
				const buf = Buffer.alloc(Math.min(UPLOAD_CHUNK, size - offset));
				const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
				return buf.subarray(0, bytesRead);
			};
			// Chunk 0 creates/truncates the file; the rest are offset writes and can go in parallel.
			await mvm.writeFile(remote, await readChunk(0), 0);
			let done = Math.min(UPLOAD_CHUNK, size);
			onProgress?.(done, size);
			const offsets: number[] = [];
			for (let o = UPLOAD_CHUNK; o < size; o += UPLOAD_CHUNK) offsets.push(o);
			let next = 0;
			const worker = async () => {
				while (next < offsets.length) {
					const o = offsets[next++];
					const chunk = await readChunk(o);
					await mvm.writeFile(remote, chunk, o);
					done += chunk.length;
					onProgress?.(done, size);
				}
			};
			await Promise.all(Array.from({ length: UPLOAD_PARALLEL }, worker));
			return size;
		} finally {
			await fh.close();
		}
	}

	async function upload(localPath: string, remotePath: string | undefined, ctx?: ExtensionContext) {
		const abs = path.resolve(localCwd, expandHome(localPath));
		const st = await fs.stat(abs);
		const dest = remotePath ? toRemote(remotePath) : path.posix.join(REMOTE_CWD, path.basename(abs));
		const progress = (done: number, total: number) =>
			ctx?.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", `MicroVM: uploading ${formatSize(done)}/${formatSize(total)}`));
		try {
			if (st.isDirectory()) {
				const tmp = path.join(os.tmpdir(), `pi-mvm-${randomBytes(6).toString("hex")}.tgz`);
				try {
					await execFileP("tar", ["-czf", tmp, "-C", abs, "."], { env: { ...env, COPYFILE_DISABLE: "1" } });
					const remoteTmp = `/tmp/pi-upload-${randomBytes(6).toString("hex")}.tgz`;
					const bytes = await uploadFile(tmp, remoteTmp, progress);
					await mvm.untar(remoteTmp, dest);
					return { kind: "directory" as const, local: abs, remote: dest, bytes };
				} finally {
					await fs.rm(tmp, { force: true });
				}
			}
			const bytes = await uploadFile(abs, dest, progress);
			return { kind: "file" as const, local: abs, remote: dest, bytes };
		} finally {
			if (ctx && mvm.id) ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", `MicroVM: ${mvm.id}`));
		}
	}

	async function download(remotePath: string, localPath: string | undefined) {
		const src = toRemote(remotePath);
		const st = await fsCall(src, () => mvm.stat(src));
		if (st.type === "dir") {
			const destDir = path.resolve(localCwd, expandHome(localPath ?? "."));
			await fs.mkdir(destDir, { recursive: true });
			const res = await mvm.tarStream(src);
			const tmp = path.join(os.tmpdir(), `pi-mvm-${randomBytes(6).toString("hex")}.tgz`);
			try {
				await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
				await execFileP("tar", ["-xzf", tmp, "-C", destDir]);
				return { kind: "directory" as const, remote: src, local: path.join(destDir, path.posix.basename(src)) };
			} finally {
				await fs.rm(tmp, { force: true });
			}
		}
		let dest = path.resolve(localCwd, expandHome(localPath ?? path.posix.basename(src)));
		if ((await fs.stat(dest).catch(() => undefined))?.isDirectory()) dest = path.join(dest, path.posix.basename(src));
		await fs.mkdir(path.dirname(dest), { recursive: true });
		const res = await mvm.request(`/fs/read?path=${encodeURIComponent(src)}`);
		await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
		return { kind: "file" as const, remote: src, local: dest, bytes: st.size };
	}

	/** Split "a b" / quoted args for commands. */
	const splitArgs = (s: string) => (s.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((a) => a.replace(/^["']|["']$/g, ""));

	pi.registerCommand("mvm-upload", {
		description: "Upload a local file/directory into the MicroVM: /mvm-upload <local> [remote]",
		handler: async (args, ctx) => {
			const [local, remote] = splitArgs(args);
			if (!local) return ctx.ui.notify("Usage: /mvm-upload <local-path> [remote-path]", "warning");
			try {
				const r = await upload(local, remote, ctx);
				ctx.ui.notify(`Uploaded ${r.kind} ${r.local} → ${r.remote} (${formatSize(r.bytes)})`, "info");
				pi.sendMessage(
					{
						customType: ENTRY_TYPE,
						content: `The user uploaded a ${r.kind} into the MicroVM: ${r.remote} (${formatSize(r.bytes)}${r.kind === "directory" ? " compressed" : ""}).`,
						display: true,
					},
					{ deliverAs: "nextTurn" },
				);
			} catch (err) {
				ctx.ui.notify(`Upload failed: ${(err as Error).message}`, "error");
			}
		},
	});

	pi.registerCommand("mvm-download", {
		description: "Download a file/directory from the MicroVM: /mvm-download <remote> [local]",
		handler: async (args, ctx) => {
			const [remote, local] = splitArgs(args);
			if (!remote) return ctx.ui.notify("Usage: /mvm-download <remote-path> [local-path]", "warning");
			try {
				const r = await download(remote, local);
				ctx.ui.notify(`Downloaded ${r.kind} ${r.remote} → ${r.local}`, "info");
			} catch (err) {
				ctx.ui.notify(`Download failed: ${(err as Error).message}`, "error");
			}
		},
	});

	pi.registerTool({
		name: "request_upload",
		label: "Request upload",
		description:
			"Ask the user to share local data with the MicroVM. The user sees your reason and must approve (they may pick a different path). " +
			"You cannot read the user's computer yourself; this is the only way to get local files into the MicroVM.",
		promptSnippet: "Ask the user to upload a local file or directory into the MicroVM",
		promptGuidelines: [
			"Use request_upload when the task needs files from the user's computer (code, datasets, configs); do not guess their contents. Leave localPath empty if you don't know the path.",
		],
		parameters: Type.Object({
			reason: Type.String({ description: "Why you need the data (shown to the user)" }),
			localPath: Type.Optional(Type.String({ description: "Suggested local path (file or directory) on the user's computer" })),
			remotePath: Type.Optional(Type.String({ description: `Destination in the MicroVM (default: ${REMOTE_CWD}/<basename>)` })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "No interactive user. Ask the user to run /mvm-upload <local-path> [remote-path]." }],
					details: undefined,
					isError: true,
				};
			}
			let local = params.localPath;
			const prompt = `The agent asks you to upload ${local ? `"${path.resolve(localCwd, expandHome(local))}"` : "local data"} into the MicroVM${params.remotePath ? ` at ${toRemote(params.remotePath)}` : ""}.\nReason: ${params.reason}`;
			const choice = await ctx.ui.select(prompt, local ? ["Upload", "Upload a different path…", "Decline"] : ["Choose a path…", "Decline"]);
			if (!choice || choice === "Decline") {
				return { content: [{ type: "text", text: "The user declined the upload." }], details: undefined };
			}
			if (choice !== "Upload") {
				local = await ctx.ui.input("Local path to upload:", local ?? localCwd);
				if (!local) return { content: [{ type: "text", text: "The user declined the upload." }], details: undefined };
			}
			const r = await upload(local!, params.remotePath, ctx);
			return withNotice({
				content: [{ type: "text" as const, text: `Uploaded ${r.kind} to ${r.remote} (${formatSize(r.bytes)}${r.kind === "directory" ? " compressed" : ""}).` }],
				details: undefined,
			});
		},
	});

	pi.registerTool({
		name: "request_download",
		label: "Request download",
		description: "Offer the user to download a file or directory from the MicroVM to their computer. The user must approve.",
		promptSnippet: "Offer the user to download results from the MicroVM to their computer",
		promptGuidelines: ["Use request_download to hand finished artifacts (reports, patches, builds) back to the user."],
		parameters: Type.Object({
			remotePath: Type.String({ description: "File or directory in the MicroVM" }),
			reason: Type.String({ description: "What it is (shown to the user)" }),
			localPath: Type.Optional(Type.String({ description: "Suggested local destination (default: current directory)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: `No interactive user. Tell the user to run /mvm-download ${toRemote(params.remotePath)}` }],
					details: undefined,
					isError: true,
				};
			}
			const dest = params.localPath ?? ".";
			const choice = await ctx.ui.select(
				`The agent offers ${toRemote(params.remotePath)} for download to ${path.resolve(localCwd, expandHome(dest))}.\n${params.reason}`,
				["Download", "Download to a different path…", "Decline"],
			);
			if (!choice || choice === "Decline") {
				return { content: [{ type: "text", text: "The user declined the download." }], details: undefined };
			}
			let local: string | undefined = dest;
			if (choice !== "Download") {
				local = await ctx.ui.input("Local destination:", dest);
				if (!local) return { content: [{ type: "text", text: "The user declined the download." }], details: undefined };
			}
			const r = await download(params.remotePath, local);
			return { content: [{ type: "text", text: `The user downloaded ${r.kind} ${r.remote}.` }], details: undefined };
		},
	});

	// --- lifecycle command ---------------------------------------------------------------------

	pi.registerCommand("mvm", {
		description: "Lambda MicroVM: /mvm [status|suspend|resume|terminate|new]",
		getArgumentCompletions: (prefix) =>
			["status", "suspend", "resume", "terminate", "new"]
				.filter((s) => s.startsWith(prefix))
				.map((s) => ({ value: s, label: s })),
		handler: async (args, ctx) => {
			const sub = args.trim() || "status";
			try {
				switch (sub) {
					case "status": {
						const d = await mvm.describe();
						if (!d) return ctx.ui.notify("No MicroVM yet (one is launched on first use).", "info");
						ctx.ui.notify(
							[
								`MicroVM: ${d.microvmId} (${d.state}${d.stateReason ? `: ${d.stateReason}` : ""})`,
								`Endpoint: ${d.endpoint}`,
								`Image: ${d.imageArn} v${d.imageVersion}  (configured: ${mvm.image})`,
								`Started: ${d.startedAt?.toISOString?.() ?? "-"}`,
								`Idle policy: suspend after ${d.idlePolicy?.maxIdleDurationSeconds}s idle, terminate after ${d.idlePolicy?.suspendedDurationSeconds}s suspended`,
								`Workspace: ${REMOTE_CWD}   On exit: ${ON_EXIT}`,
							].join("\n"),
							"info",
						);
						return;
					}
					case "suspend":
						await mvm.suspend();
						ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("muted", "MicroVM: suspended"));
						return ctx.ui.notify("MicroVM suspending (it auto-resumes on next use).", "info");
					case "resume":
						await mvm.resume();
						return ctx.ui.notify(`MicroVM ${mvm.id} running`, "info");
					case "terminate":
					case "new": {
						const old = mvm.id;
						if (sub === "terminate" && !(await ctx.ui.confirm("Terminate MicroVM?", "All files and processes in it are lost."))) return;
						await mvm.terminate();
						pi.appendEntry(ENTRY_TYPE, { microvmId: null });
						ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("muted", "MicroVM: none"));
						if (sub === "new") await mvm.ensure();
						else ctx.ui.notify(`Terminated ${old ?? "(none)"}`, "info");
						pi.sendMessage(
							{ customType: ENTRY_TYPE, content: `The user ${sub === "new" ? "replaced" : "terminated"} the MicroVM; earlier files and processes in it are gone.`, display: true },
							{ deliverAs: "nextTurn" },
						);
						return;
					}
					default:
						ctx.ui.notify("Usage: /mvm [status|suspend|resume|terminate|new]", "warning");
				}
			} catch (err) {
				ctx.ui.notify(`MicroVM ${sub} failed: ${(err as Error).message}`, "error");
			}
		},
	});

	// --- events -----------------------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		uiCtx = ctx;
		if (!env.PI_MVM_IMAGE) {
			mvm.image = imageFromSettings(pi.getSettings()) ?? DEFAULT_IMAGE;
		}
		let saved: Partial<MicrovmIdentity> | undefined;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === ENTRY_TYPE) saved = entry.data as Partial<MicrovmIdentity>;
		}
		if (saved?.microvmId && saved.secret) mvm.attach(saved as MicrovmIdentity);
		// Warm up in the background so the first tool call is fast.
		mvm.ensure().catch((err) => {
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("error", "MicroVM: error"));
			ctx.ui.notify(`Lambda MicroVM unavailable: ${(err as Error).message}`, "error");
		});
	});

	pi.on("session_shutdown", async () => {
		if (!mvm.id || ON_EXIT === "keep") return;
		try {
			if (ON_EXIT === "terminate") await mvm.terminate();
			else await mvm.suspend();
		} catch {
			// best effort; the idle policy suspends/terminates it anyway
		}
	});

	// User `!cmd` / `!!cmd` also run in the MicroVM.
	pi.on("user_bash", () => ({ operations: bashOps }));

	pi.on("before_agent_start", async (event) => {
		const opts = event.systemPromptOptions;
		localReadRoots.clear();
		for (const skill of opts.skills ?? []) {
			const real = await fs.realpath(skill.baseDir).catch(() => undefined);
			if (real) localReadRoots.add(real);
		}
		opts.sections.cwd = `${REMOTE_CWD} (inside an isolated AWS Lambda MicroVM${mvm.id ? ` ${mvm.id}` : ""})`;
		opts.sections.lambda_microvm = [
			"All your tools (bash, read, write, edit, ls, find, grep) operate inside a dedicated AWS Lambda MicroVM (Firecracker, Amazon Linux 2023), not on the user's computer.",
			`- Your working directory is ${REMOTE_CWD} in the MicroVM. It starts empty unless the user uploaded something.`,
			"- You cannot see or modify the user's local files. Paths mentioned by the user or in project context refer to their computer, not the MicroVM.",
			"- When you need local data, call request_upload (or ask the user to run /mvm-upload <local-path> [remote-path]).",
			"- To give results back, call request_download (or tell the user to run /mvm-download <remote-path> [local-path]).",
			"- You may install packages (dnf, pip, npm) and use the internet from the MicroVM. State persists while the MicroVM lives (max 8h); it suspends when idle and resumes on the next command.",
			"- Background processes are frozen while the MicroVM is suspended.",
			localReadRoots.size ? "- Exception: skill files listed in <skills> are read from the user's computer by the read tool (read-only)." : "",
		]
			.filter(Boolean)
			.join("\n");
	});
}

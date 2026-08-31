import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  validatePrpEvent,
  type PrpEvent,
} from "../protocol/replay-contract.js";

import { CapabilityMockControlPlaneAdapter } from "../mock-core/capability-mock-control-plane-adapter.js";
import type { CapabilityFixtureSeed } from "../mock-core/capability-control-plane-types.js";
import { capabilitySemanticToolDescriptor } from "../semantic-tools/catalog.js";
import { CapabilitySemanticDispatcher } from "../semantic-tools/dispatcher.js";
import { CAPABILITY_DISCOVERY_GATEWAY_DEFINITIONS } from "../semantic-tools/discovery.js";
import { digestPaperclipSemanticContent } from "../semantic-tools/receipts.js";
import {
  resolveQualifiedAcpxProfile,
  type QualifiedAcpxAgent,
} from "../drivers/acpx/qualified-profiles.js";
import { createSanitizedAcpxEnvironment } from "../drivers/acpx/environment.js";
import { createSanitizedClaudeManagedEnvironment } from "../drivers/claude-managed/environment.js";

import {
  DURABLE_RECOVERY_FAULTS,
  type DurableRecoveryCommittedEvent,
  type DurableRecoveryCoreCommand,
  type DurableRecoveryDiagnostics,
  type DurableRecoveryFault,
  type DurableRecoveryIdentity,
  type DurableRecoveryRunnerState,
  type DurableRecoveryRunTrace,
} from "../contracts/durable-recovery.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const runnerBinary = resolve(
  packageRoot,
  `runner/target/debug/paperclip-runnerd${executableSuffix}`,
);
const fakeHarnessBinary = resolve(
  packageRoot,
  `runner/target/debug/fake-harness${executableSuffix}`,
);
const fakeCodexBinary = resolve(
  packageRoot,
  `runner/target/debug/fake-codex-app-server${executableSuffix}`,
);
const fakeHarnessScript = resolve(
  packageRoot,
  "protocol/fixtures/local-runner/scripts/happy-path.json",
);
const protocol = "paperclip.runner";
const protocolVersion = 1;
const secureFrameSchema = "paperclip.runner.secure-frame.v1";
const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const coreStateSchema = "paperclip.runner.durable.control-plane-state.v1";
const maxFrameBytes = 1024 * 1024;
const authChallengeTtlMs = 5_000;
const stableIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/;
const commandTypes = new Set([
  "run.prepare",
  "run.attach",
  "session.open",
  "turn.start",
  "turn.steer",
  "turn.interrupt",
  "turn.stop",
  "request.resolve",
  "interaction.receipt",
  "semantic_tool.result",
  "session.snapshot",
  "session.close",
  "session.budget.increase",
  "session.destroy",
  "run.cancel",
  "runner.drain",
  "runner.suspend",
  "runner.shutdown",
  // Deterministic recovery-eval commands retained by this branch.
  "fault.harness_restart",
  "fault.storage_pressure",
]);

function durableEvalConnectionLeaseTtlMs(turnTimeoutMs: number): number {
  return Math.max(60 * 60 * 1_000, turnTimeoutMs + 60_000);
}

interface BootstrapTicketRecord {
  recordId: string;
  credentialId: string;
  authKeyDigest: string;
  identity: DurableRecoveryIdentity;
  runnerVersion: string;
  runnerDigest: string;
  expiresAt: string;
  expiresAtUnixMs: number;
  usedAt: string | null;
}

interface ConnectionLeaseRecord {
  recordId: string;
  credentialId: string;
  authKeyDigest: string;
  leaseId: string;
  identity: DurableRecoveryIdentity;
  protocolVersion: number;
  expiresAt: string;
  expiresAtUnixMs: number;
  revocationEpoch: number;
  revokedAt: string | null;
}

interface StoredCoreState {
  schema: typeof coreStateSchema;
  identity: DurableRecoveryIdentity;
  tickets: Record<string, BootstrapTicketRecord>;
  leases: Record<string, ConnectionLeaseRecord>;
  commands: DurableRecoveryCoreCommand[];
  committedEvents: DurableRecoveryCommittedEvent[];
  ackedSourceSeq: number;
  connectionCount: number;
  commandDeliveryCounts: Record<string, number>;
  replayDeliveries: number;
  duplicateCommandResults: number;
  freshBootstraps: number;
  malformedFrames: number;
  lastLeaseId: string | null;
  lastLeaseExpiresAt: string | null;
}

type PendingAuthorization =
  | {
      kind: "bootstrap";
      recordId: string;
      credentialId: string;
      authKey: Buffer;
      identity: DurableRecoveryIdentity;
      runnerVersion: string;
      runnerDigest: string;
      expiresAt: string;
      expiresAtUnixMs: number;
      recordSnapshot: string;
    }
  | {
      kind: "lease";
      recordId: string;
      credentialId: string;
      authKey: Buffer;
      identity: DurableRecoveryIdentity;
      protocolVersion: number;
      expiresAt: string;
      expiresAtUnixMs: number;
      leaseId: string;
      revocationEpoch: number;
      recordSnapshot: string;
    };

type LiveAuthorization =
  | {
      kind: "bootstrap";
      authKey: Buffer;
      ticket: BootstrapTicketRecord;
    }
  | {
      kind: "lease";
      authKey: Buffer;
      lease: ConnectionLeaseRecord;
    };

interface PendingChallenge {
  authorization: PendingAuthorization;
  deadlineUnixMs: number;
  canonicalChallenge: string;
  serverProof: string;
  clientNonce: string;
  serverNonce: string;
}

interface SecureChannel {
  sendKey: Buffer;
  receiveKey: Buffer;
  sendCounter: bigint;
  receiveCounter: bigint;
  sessionId: string;
}

export interface DurablePrpControlPlaneOptions {
  stateDirectory: string;
  identity: DurableRecoveryIdentity;
  /** Test-only transport fault. Production callers omit this. */
  fault?: DurableRecoveryFault;
  expectedRunnerVersion?: string;
  expectedRunnerDigest?: string;
  onSemanticToolInput?: (input: {
    callId: string;
    operationId: string;
    input: unknown;
    correlation: {
      runId: string;
      normalizedSessionId: string;
      turnId: string;
      itemId: string;
    };
    /** Internal trace lineage for the canonical semantic_tool.input event. */
    sourceEventId?: string;
    sourceEventType?: string;
  }) => Promise<unknown>;
  onCommittedEvent?: (event: PrpEvent) => Promise<void>;
  connectionLeaseTtlMs?: number;
}

export interface RunnerProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface RunnerProcessHandle {
  child: {
    pid?: number;
    exitCode: number | null;
    signalCode?: NodeJS.Signals | null;
    kill(signal?: NodeJS.Signals | number): boolean;
  };
  completion: Promise<RunnerProcessResult>;
  /** Relaunches the same immutable process specification with a fresh ticket. */
  restart?(ticket: string): RunnerProcessHandle;
}

export type RunnerProcessConnection =
  | { mode: "connect"; connectUrl: string; caBundlePath?: string }
  | {
      mode: "listen";
      listenAddress: "0.0.0.0";
      listenPort: number;
      listenPath: string;
    };

export interface RunnerProcessLaunchSpec {
  command: string;
  args: readonly string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
}

function domainDigest(domain: string, parts: readonly Buffer[]): Buffer {
  const digest = createHash("sha256")
    .update(domain)
    .update(Buffer.from([0]));
  for (const part of parts) {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(part.length));
    digest.update(length).update(part);
  }
  return digest.digest();
}

function domainHmac(
  key: Buffer,
  domain: string,
  parts: readonly Buffer[],
): Buffer {
  const digest = createHmac("sha256", key)
    .update(domain)
    .update(Buffer.from([0]));
  for (const part of parts) {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(part.length));
    digest.update(length).update(part);
  }
  return digest.digest();
}

function credentialMaterial(token: string): {
  credentialId: string;
  authKey: Buffer;
} {
  const bytes = Buffer.from(token);
  return {
    credentialId: `sha256:${domainDigest("paperclip-runner-credential-id-v1", [bytes]).toString("hex")}`,
    authKey: domainDigest("paperclip-runner-auth-key-v1", [bytes]),
  };
}

function tokenDigest(token: string): string {
  return `sha256:${credentialMaterial(token).authKey.toString("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function safeDate(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function authKeyFromDigest(digest: string): Buffer {
  const hex = digest.match(/^sha256:([0-9a-f]{64})$/)?.[1];
  if (hex === undefined)
    throw new Error("Stored transport authentication key is malformed.");
  return Buffer.from(hex, "hex");
}

function proofMatches(expected: Buffer, supplied: unknown): boolean {
  if (typeof supplied !== "string" || !/^[0-9a-f]{64}$/.test(supplied))
    return false;
  return timingSafeEqual(expected, Buffer.from(supplied, "hex"));
}

function createSecureChannel(
  authKey: Buffer,
  canonicalChallenge: string,
  serverProof: string,
  clientProof: string,
): SecureChannel {
  const parts = [
    Buffer.from(canonicalChallenge),
    Buffer.from(serverProof),
    Buffer.from(clientProof),
  ];
  const binding = domainDigest("paperclip-runner-session-binding-v1", parts);
  return {
    sendKey: domainHmac(authKey, "paperclip-runner-core-to-client-key-v1", [
      binding,
    ]),
    receiveKey: domainHmac(authKey, "paperclip-runner-client-to-core-key-v1", [
      binding,
    ]),
    sendCounter: 0n,
    receiveCounter: 0n,
    sessionId: `sha256:${binding.toString("hex")}`,
  };
}

function secureNonce(prefix: "P3C1" | "P3S1", counter: bigint): Buffer {
  const nonce = Buffer.alloc(12);
  nonce.write(prefix, 0, "ascii");
  nonce.writeBigUInt64BE(counter, 4);
  return nonce;
}

function secureAad(
  channel: SecureChannel,
  direction: "client_to_core" | "core_to_client",
  counter: bigint,
): Buffer {
  return Buffer.from(
    `${secureFrameSchema}\0${channel.sessionId}\0${direction}\0${counter}`,
  );
}

function encryptSecureJson(
  channel: SecureChannel,
  value: unknown,
): Record<string, unknown> {
  const counter = channel.sendCounter;
  const cipher = createCipheriv(
    "aes-256-gcm",
    channel.sendKey,
    secureNonce("P3S1", counter),
  );
  cipher.setAAD(secureAad(channel, "core_to_client", counter));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(value))),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  channel.sendCounter += 1n;
  return {
    schema: secureFrameSchema,
    counter: Number(counter),
    ciphertext: ciphertext.toString("hex"),
  };
}

function decryptSecureJson(
  channel: SecureChannel,
  value: unknown,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error("Secure frame must be an object.");
  }
  const frame = value as Record<string, unknown>;
  if (
    frame.schema !== secureFrameSchema ||
    typeof frame.counter !== "number" ||
    !Number.isSafeInteger(frame.counter) ||
    BigInt(frame.counter) !== channel.receiveCounter ||
    typeof frame.ciphertext !== "string" ||
    !/^[0-9a-f]+$/.test(frame.ciphertext) ||
    frame.ciphertext.length % 2 !== 0
  ) {
    throw new Error("Secure frame metadata or counter is invalid.");
  }
  const sealed = Buffer.from(frame.ciphertext, "hex");
  if (sealed.length < 16)
    throw new Error("Secure frame authentication tag is missing.");
  const ciphertext = sealed.subarray(0, -16);
  const tag = sealed.subarray(-16);
  const counter = channel.receiveCounter;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    channel.receiveKey,
    secureNonce("P3C1", counter),
  );
  decipher.setAAD(secureAad(channel, "client_to_core", counter));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  channel.receiveCounter += 1n;
  return JSON.parse(plaintext.toString("utf8")) as Record<string, unknown>;
}

function initialCoreState(identity: DurableRecoveryIdentity): StoredCoreState {
  return {
    schema: coreStateSchema,
    identity,
    tickets: {},
    leases: {},
    commands: [],
    committedEvents: [],
    ackedSourceSeq: 0,
    connectionCount: 0,
    commandDeliveryCounts: {},
    replayDeliveries: 0,
    duplicateCommandResults: 0,
    freshBootstraps: 0,
    malformedFrames: 0,
    lastLeaseId: null,
    lastLeaseExpiresAt: null,
  };
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function verifyPrivateDirectory(path: string): void {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Private state directory is not a real directory: ${path}`);
  }
  if (process.platform !== "win32") {
    if ((metadata.mode & 0o777) !== 0o700) {
      throw new Error(
        `Private state directory does not use mode 0700: ${path}`,
      );
    }
    if (process.geteuid !== undefined && metadata.uid !== process.geteuid()) {
      throw new Error(
        `Private state directory is not owned by the daemon user: ${path}`,
      );
    }
  }
}

function verifyPrivateRegularFile(file: Stats, path: string): void {
  if (!file.isFile()) {
    throw new Error(`Private state path is not a regular file: ${path}`);
  }
  if (process.platform !== "win32") {
    if ((file.mode & 0o777) !== 0o600) {
      throw new Error(`Private state file does not use mode 0600: ${path}`);
    }
    if (process.geteuid !== undefined && file.uid !== process.geteuid()) {
      throw new Error(
        `Private state file is not owned by the daemon user: ${path}`,
      );
    }
  }
}

function readPrivateFile(path: string): string | null {
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
  try {
    verifyPrivateRegularFile(fstatSync(descriptor), path);
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function syncParentDirectory(path: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(
    dirname(path),
    constants.O_RDONLY |
      (constants.O_DIRECTORY ?? 0) |
      (constants.O_NOFOLLOW ?? 0),
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function atomicPrivateWrite(path: string, contents: string): void {
  const temporary = resolve(
    dirname(path),
    `.${path.split(/[\\/]/).at(-1)}.${randomUUID()}.tmp`,
  );
  let descriptor: number | null = null;
  let created = false;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    created = true;
    if (process.platform !== "win32") fchmodSync(descriptor, 0o600);
    verifyPrivateRegularFile(fstatSync(descriptor), temporary);
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, path);
    created = false;
    syncParentDirectory(path);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (created) {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
      }
    }
  }
}

class DurableCoreStore {
  readonly path: string;
  #state: StoredCoreState;

  constructor(directory: string, identity: DurableRecoveryIdentity) {
    try {
      const metadata = lstatSync(directory);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(
          `Private state directory is not a real directory: ${directory}`,
        );
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    if (process.platform !== "win32") chmodSync(directory, 0o700);
    verifyPrivateDirectory(directory);
    this.path = resolve(directory, "mock-core-state.json");
    const stored = readPrivateFile(this.path);
    if (stored !== null) {
      this.#state = JSON.parse(stored) as StoredCoreState;
      if (
        this.#state.schema !== coreStateSchema ||
        canonicalJson(this.#state.identity) !== canonicalJson(identity)
      ) {
        throw new Error(
          "Mock core state does not match the requested Durable recovery identity.",
        );
      }
    } else {
      this.#state = initialCoreState(identity);
      this.save();
    }
  }

  get state(): StoredCoreState {
    return this.#state;
  }

  save(): void {
    atomicPrivateWrite(this.path, `${JSON.stringify(this.#state, null, 2)}\n`);
  }
}

export interface TransportCloseReason {
  readonly code?: number;
  readonly message?: string;
  readonly error?: unknown;
}

/** A transport-neutral JSON peer. PRP authentication and encryption stay above it. */
export interface PrpWireConnection {
  sendJson(value: unknown): void;
  close(code?: number): void;
  onJson(listener: (value: unknown) => void): void;
  onClose(listener: (reason: TransportCloseReason) => void): void;
}

export interface PrpWireAttachment {
  isAuthenticated(): boolean;
}

class RawWebSocketWireConnection implements PrpWireConnection {
  readonly socket: Duplex;
  #buffer = Buffer.alloc(0);
  #closed = false;
  #onJson: (value: unknown) => void = () => undefined;
  #onClose: (reason: TransportCloseReason) => void = () => undefined;

  constructor(socket: Duplex) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => this.#consume(chunk));
    socket.on("close", () => {
      if (!this.#closed) {
        this.#closed = true;
        this.#onClose({ message: "socket_closed" });
      }
    });
    socket.on("error", (error) => {
      if (this.#closed) return;
      this.#closed = true;
      this.#onClose({ message: "socket_error", error });
    });
  }

  onJson(listener: (value: unknown) => void): void {
    this.#onJson = listener;
  }

  onClose(listener: (reason: TransportCloseReason) => void): void {
    this.#onClose = listener;
  }

  acceptInitialData(data: Buffer<ArrayBufferLike>): void {
    if (data.length > 0) this.#consume(data);
  }

  sendJson(value: unknown): void {
    this.sendText(JSON.stringify(value));
  }

  sendText(text: string): void {
    if (this.#closed) {
      return;
    }
    const payload = Buffer.from(text);
    const header: number[] = [0x81];
    if (payload.length <= 125) {
      header.push(payload.length);
    } else if (payload.length <= 0xffff) {
      header.push(126, (payload.length >>> 8) & 0xff, payload.length & 0xff);
    } else {
      const length = BigInt(payload.length);
      header.push(127);
      for (let shift = 56n; shift >= 0n; shift -= 8n) {
        header.push(Number((length >> shift) & 0xffn));
      }
    }
    this.socket.write(Buffer.concat([Buffer.from(header), payload]));
  }

  close(_code?: number): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.socket.destroy();
    this.#onClose({ message: "local_close" });
  }

  #consume(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.length >= 2) {
      const first = this.#buffer[0]!;
      const second = this.#buffer[1]!;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let cursor = 2;
      if (length === 126) {
        if (this.#buffer.length < 4) return;
        length = this.#buffer.readUInt16BE(2);
        cursor = 4;
      } else if (length === 127) {
        if (this.#buffer.length < 10) return;
        const extended = this.#buffer.readBigUInt64BE(2);
        if (extended > BigInt(maxFrameBytes)) {
          this.close();
          return;
        }
        length = Number(extended);
        cursor = 10;
      }
      if (length > maxFrameBytes || !masked) {
        this.close();
        return;
      }
      if (this.#buffer.length < cursor + 4 + length) return;
      const mask = this.#buffer.subarray(cursor, cursor + 4);
      cursor += 4;
      const payload = Buffer.from(
        this.#buffer.subarray(cursor, cursor + length),
      );
      this.#buffer = this.#buffer.subarray(cursor + length);
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] = payload[index]! ^ mask[index % 4]!;
      }
      if (opcode === 0x1) {
        try {
          this.#onJson(JSON.parse(payload.toString("utf8")) as unknown);
        } catch (error) {
          this.#closed = true;
          this.socket.destroy();
          this.#onClose({ message: "invalid_json", error });
          return;
        }
      } else if (opcode === 0x8) {
        this.close();
        return;
      } else if (opcode === 0x9) {
        this.#sendControl(0x0a, payload);
      } else if (opcode !== 0x0a) {
        this.close();
        return;
      }
    }
  }

  #sendControl(opcode: number, payload: Buffer): void {
    if (payload.length > 125 || this.#closed) return;
    this.socket.write(
      Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]),
    );
  }
}

class AuthorityConnection {
  pendingChallenge: PendingChallenge | null = null;
  secureChannel: SecureChannel | null = null;
  lease: ConnectionLeaseRecord | null = null;
  connectionId: string | null = null;
  readonly wire: PrpWireConnection;
  #closed = false;
  #onClose: () => void;

  constructor(input: {
    wire: PrpWireConnection;
    onJson: (value: unknown) => void;
    onClose: () => void;
  }) {
    this.wire = input.wire;
    this.#onClose = input.onClose;
    this.wire.onJson(input.onJson);
    this.wire.onClose(() => this.#markClosed());
  }

  sendJson(value: unknown): void {
    if (this.#closed) return;
    this.wire.sendJson(
      this.secureChannel === null
        ? value
        : encryptSecureJson(this.secureChannel, value),
    );
  }

  close(code?: number): void {
    if (this.#closed) return;
    this.#closed = true;
    this.wire.close(code);
    this.#onClose();
  }

  #markClosed(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#onClose();
  }
}

/** Authenticated, replay-safe PRP transport authority. Business operations are caller supplied. */
export class DurablePrpControlPlane {
  readonly fault: DurableRecoveryFault;
  readonly identity: DurableRecoveryIdentity;
  readonly store: DurableCoreStore;
  #expectedRunnerVersion: string;
  #expectedRunnerDigest: string;
  #server: Server | null = null;
  #connections = new Set<AuthorityConnection>();
  #port: number | null = null;
  #faultTriggered = false;
  #replayCursorOverrideOnce = false;
  #onSemanticToolInput?: DurablePrpControlPlaneOptions["onSemanticToolInput"];
  #onCommittedEvent?: DurablePrpControlPlaneOptions["onCommittedEvent"];
  #pendingSemanticCalls = new Set<string>();
  #connectionLeaseTtlMs: number;
  #faultTriggerResolve!: () => void;
  #faultTrigger = new Promise<void>((resolveFault) => {
    this.#faultTriggerResolve = resolveFault;
  });

  constructor(options: DurablePrpControlPlaneOptions) {
    const fault = options.fault ?? "none";
    if (!DURABLE_RECOVERY_FAULTS.includes(fault)) {
      throw new Error(`Unsupported Durable recovery fault: ${fault}`);
    }
    this.fault = fault;
    this.identity = options.identity;
    this.store = new DurableCoreStore(options.stateDirectory, options.identity);
    this.#expectedRunnerVersion = options.expectedRunnerVersion ?? "0.3.0";
    this.#expectedRunnerDigest =
      options.expectedRunnerDigest ?? "sha256:durable-recovery-approved";
    this.#onSemanticToolInput = options.onSemanticToolInput;
    this.#onCommittedEvent = options.onCommittedEvent;
    this.#connectionLeaseTtlMs = options.connectionLeaseTtlMs ?? 30_000;
  }

  get connectUrl(): string {
    if (this.#port === null) {
      throw new Error("Durable PRP control plane is not listening.");
    }
    return `ws://127.0.0.1:${this.#port}/durableRecovery/connect`;
  }

  async start(port = 0): Promise<void> {
    if (this.#server !== null) {
      throw new Error("Durable PRP control plane is already running.");
    }
    const server = createServer((_request, response) => {
      response.writeHead(404).end();
    });
    this.#server = server;
    server.on("upgrade", (request, socket, head) =>
      this.handleUpgrade(request, socket, "/durableRecovery/connect", head),
    );
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", rejectListen);
        resolveListen();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Durable PRP control plane did not bind a TCP port.");
    }
    this.#port = address.port;
  }

  async stop(): Promise<void> {
    for (const connection of this.#connections) {
      connection.close();
    }
    this.#connections.clear();
    const server = this.#server;
    this.#server = null;
    this.#port = null;
    if (server !== null) {
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose()),
      );
    }
  }

  /** Forces a resumable re-authentication after an immutable run attachment rotates. */
  disconnectActiveRunner(): void {
    const connections = [...this.#connections];
    this.#connections.clear();
    for (const connection of connections) connection.close();
  }

  activeRunnerConnectionCount(): number {
    return [...this.#connections].filter(
      (connection) => connection.secureChannel !== null,
    ).length;
  }

  issueBootstrapTicket(ttlMs = 5_000): string {
    const ticket = `bootstrap_${randomUUID()}`;
    const material = credentialMaterial(ticket);
    const expiresAtUnixMs = Date.now() + ttlMs;
    this.store.state.tickets[material.credentialId] = {
      recordId: `bootstrap_ticket_${randomUUID()}`,
      credentialId: material.credentialId,
      authKeyDigest: `sha256:${material.authKey.toString("hex")}`,
      identity: structuredClone(this.identity),
      runnerVersion: this.#expectedRunnerVersion,
      runnerDigest: this.#expectedRunnerDigest,
      expiresAt: new Date(expiresAtUnixMs).toISOString(),
      expiresAtUnixMs,
      usedAt: null,
    };
    this.store.state.freshBootstraps += 1;
    this.store.save();
    return ticket;
  }

  queueCommand(
    type: string,
    payload: Record<string, unknown> = {},
    commandId?: string,
    deliverImmediately = false,
  ): DurableRecoveryCoreCommand {
    if (
      !commandTypes.has(type) ||
      (commandId !== undefined &&
        (commandId.length > 160 || !stableIdPattern.test(commandId)))
    ) {
      throw new Error("Durable PRP command is invalid.");
    }
    if (commandId !== undefined) {
      const existing = this.store.state.commands.find(
        (candidate) => candidate.commandId === commandId,
      );
      if (existing !== undefined) {
        if (
          existing.type !== type ||
          canonicalJson(existing.payload) !== canonicalJson(payload)
        ) {
          throw new Error(
            "Durable PRP command replay conflicts with persisted state.",
          );
        }
        if (deliverImmediately && existing.status === "pending") {
          for (const connection of this.#connections) {
            if (connection.secureChannel !== null) {
              this.#sendNextCommand(connection);
            }
          }
        }
        return existing;
      }
    }
    const controllerSeq = this.store.state.commands.length + 1;
    const command: DurableRecoveryCoreCommand = {
      schema: "paperclip.prp.command.v1",
      commandId:
        commandId ??
        `command_durableRecovery_${controllerSeq.toString().padStart(3, "0")}`,
      controllerSeq,
      type,
      issuedAt: `2026-08-07T23:30:${controllerSeq.toString().padStart(2, "0")}.000Z`,
      payload,
      status: "pending",
      result: null,
    };
    this.store.state.commands.push(command);
    this.store.save();
    if (deliverImmediately) {
      for (const connection of this.#connections) {
        if (connection.secureChannel !== null) {
          this.#sendNextCommand(connection);
        }
      }
    }
    return command;
  }

  waitForFaultTrigger(): Promise<void> {
    return this.#faultTrigger;
  }

  #triggerFault(): void {
    if (!this.#faultTriggered) {
      this.#faultTriggered = true;
      this.#faultTriggerResolve();
    }
  }

  /** Attach one HTTP upgrade to this run-bound authority. */
  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    expectedPath = "/api/runner/v1/connect",
    head: Buffer<ArrayBufferLike> = Buffer.alloc(0),
  ): void {
    const requestPath = new URL(request.url ?? "/", "http://paperclip.invalid")
      .pathname;
    if (requestPath !== expectedPath) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const websocketKey = request.headers["sec-websocket-key"];
    if (typeof websocketKey !== "string") {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const accept = createHash("sha1")
      .update(`${websocketKey}${websocketGuid}`)
      .digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "\r\n",
      ].join("\r\n"),
    );
    const wire = new RawWebSocketWireConnection(socket);
    this.attachWireConnection(wire);
    wire.acceptInitialData(head);
  }

  /** Attach either an accepted inbound WebSocket or a Paperclip-opened peer. */
  attachWireConnection(wire: PrpWireConnection): PrpWireAttachment {
    let connection!: AuthorityConnection;
    let processing = Promise.resolve();
    connection = new AuthorityConnection({
      wire,
      onJson: (value) => {
        processing = processing
          .then(() => this.#handleJson(connection, value))
          .catch(() => connection.close());
      },
      onClose: () => this.#connections.delete(connection),
    });
    this.#connections.add(connection);
    return {
      isAuthenticated: () => connection.secureChannel !== null,
    };
  }

  async #handleJson(
    connection: AuthorityConnection,
    wire: unknown,
  ): Promise<void> {
    let envelope: Record<string, unknown>;
    try {
      envelope =
        connection.secureChannel === null
          ? (wire as Record<string, unknown>)
          : decryptSecureJson(connection.secureChannel, wire);
    } catch {
      this.store.state.malformedFrames += 1;
      this.store.save();
      connection.close();
      return;
    }
    if (
      envelope.protocol !== protocol ||
      envelope.version !== protocolVersion
    ) {
      connection.close();
      return;
    }
    const kind = envelope.kind;
    if (connection.secureChannel === null && kind === "auth_hello") {
      this.#authHello(connection, envelope);
      return;
    }
    if (connection.secureChannel === null && kind === "auth_response") {
      this.#authResponse(connection, envelope);
      return;
    }
    if (connection.secureChannel === null || connection.lease === null) {
      connection.close();
      return;
    }
    if (kind === "event") {
      await this.#event(connection, envelope);
      return;
    }
    if (kind === "command_result") {
      this.#commandResult(connection, envelope);
      return;
    }
    if (kind !== "pong") {
      connection.close();
    }
  }

  #authorizeHello(
    payload: Record<string, unknown>,
  ): PendingAuthorization | null {
    const credentialId = payload.credentialId;
    if (typeof credentialId !== "string") return null;
    const ticket = this.store.state.tickets[credentialId];
    const lease = this.store.state.leases[credentialId];
    const authorization: PendingAuthorization | null =
      ticket !== undefined &&
      typeof ticket.recordId === "string" &&
      ticket.credentialId === credentialId &&
      ticket.usedAt === null &&
      ticket.expiresAtUnixMs > Date.now()
        ? {
            kind: "bootstrap",
            recordId: ticket.recordId,
            credentialId: ticket.credentialId,
            authKey: authKeyFromDigest(ticket.authKeyDigest),
            identity: structuredClone(ticket.identity),
            runnerVersion: ticket.runnerVersion,
            runnerDigest: ticket.runnerDigest,
            expiresAt: ticket.expiresAt,
            expiresAtUnixMs: ticket.expiresAtUnixMs,
            recordSnapshot: canonicalJson(ticket),
          }
        : lease !== undefined &&
            typeof lease.recordId === "string" &&
            lease.credentialId === credentialId &&
            lease.revokedAt === null &&
            lease.expiresAtUnixMs > Date.now()
          ? {
              kind: "lease",
              recordId: lease.recordId,
              credentialId: lease.credentialId,
              authKey: authKeyFromDigest(lease.authKeyDigest),
              identity: structuredClone(lease.identity),
              protocolVersion: lease.protocolVersion,
              expiresAt: lease.expiresAt,
              expiresAtUnixMs: lease.expiresAtUnixMs,
              leaseId: lease.leaseId,
              revocationEpoch: lease.revocationEpoch,
              recordSnapshot: canonicalJson(lease),
            }
          : null;
    if (authorization === null) return null;
    const identity = authorization.identity;
    if (
      payload.runnerInstanceId !== identity.runnerInstanceId ||
      payload.environmentLeaseId !== identity.environmentLeaseId ||
      payload.runId !== identity.runId ||
      payload.normalizedSessionId !== identity.normalizedSessionId ||
      payload.turnId !== identity.turnId ||
      payload.itemId !== identity.itemId ||
      payload.runnerVersion !== this.#expectedRunnerVersion ||
      payload.runnerDigest !== this.#expectedRunnerDigest ||
      payload.protocolMin !== 1 ||
      payload.protocolMax !== 1 ||
      (authorization.kind === "bootstrap" &&
        (authorization.runnerVersion !== this.#expectedRunnerVersion ||
          authorization.runnerDigest !== this.#expectedRunnerDigest)) ||
      (authorization.kind === "lease" &&
        authorization.protocolVersion !== protocolVersion)
    ) {
      return null;
    }
    return authorization;
  }

  #reauthorizePendingChallenge(
    pending: PendingChallenge,
    now: number,
  ): LiveAuthorization | null {
    if (pending.deadlineUnixMs <= now) return null;
    const expected = pending.authorization;
    if (expected.kind === "bootstrap") {
      const ticket = this.store.state.tickets[expected.credentialId];
      if (
        ticket === undefined ||
        ticket.recordId !== expected.recordId ||
        ticket.credentialId !== expected.credentialId ||
        ticket.usedAt !== null ||
        ticket.expiresAtUnixMs <= now ||
        canonicalJson(ticket) !== expected.recordSnapshot
      ) {
        return null;
      }
      return {
        kind: "bootstrap",
        authKey: authKeyFromDigest(ticket.authKeyDigest),
        ticket,
      };
    }

    const lease = this.store.state.leases[expected.credentialId];
    if (
      lease === undefined ||
      lease.recordId !== expected.recordId ||
      lease.credentialId !== expected.credentialId ||
      lease.revokedAt !== null ||
      lease.expiresAtUnixMs <= now ||
      canonicalJson(lease) !== expected.recordSnapshot
    ) {
      return null;
    }
    return {
      kind: "lease",
      authKey: authKeyFromDigest(lease.authKeyDigest),
      lease,
    };
  }

  #authHello(
    connection: AuthorityConnection,
    envelope: Record<string, unknown>,
  ): void {
    if (connection.pendingChallenge !== null) {
      connection.close();
      return;
    }
    const payload = envelope.payload as Record<string, unknown> | undefined;
    if (payload === undefined || typeof payload.clientNonce !== "string") {
      connection.close();
      return;
    }
    const authorization = this.#authorizeHello(payload);
    if (authorization === null) {
      connection.close();
      return;
    }
    const serverNonce = randomUUID();
    const challengePayload: Record<string, unknown> = {
      credentialId: authorization.credentialId,
      credentialKind: authorization.kind,
      clientNonce: payload.clientNonce,
      serverNonce,
      runnerInstanceId: payload.runnerInstanceId,
      environmentLeaseId: payload.environmentLeaseId,
      runId: payload.runId,
      normalizedSessionId: payload.normalizedSessionId,
      turnId: payload.turnId,
      itemId: payload.itemId,
      runnerVersion: payload.runnerVersion,
      runnerDigest: payload.runnerDigest,
      selectedVersion: protocolVersion,
      credentialLeaseId:
        authorization.kind === "lease" ? authorization.leaseId : null,
      credentialExpiresAt: authorization.expiresAt,
      credentialExpiresAtUnixMs: authorization.expiresAtUnixMs,
      revocationEpoch:
        authorization.kind === "lease" ? authorization.revocationEpoch : 0,
    };
    const canonicalChallenge = canonicalJson(challengePayload);
    const serverProof = domainHmac(
      authorization.authKey,
      "paperclip-runner-server-proof-v1",
      [Buffer.from(canonicalChallenge)],
    ).toString("hex");
    connection.pendingChallenge = {
      authorization,
      deadlineUnixMs: Math.min(
        authorization.expiresAtUnixMs,
        Date.now() + authChallengeTtlMs,
      ),
      canonicalChallenge,
      serverProof,
      clientNonce: payload.clientNonce,
      serverNonce,
    };
    connection.sendJson({
      protocol,
      version: protocolVersion,
      kind: "auth_challenge",
      payload: { ...challengePayload, serverProof },
    });
  }

  #authResponse(
    connection: AuthorityConnection,
    envelope: Record<string, unknown>,
  ): void {
    const pending = connection.pendingChallenge;
    const payload = envelope.payload as Record<string, unknown> | undefined;
    if (
      pending === null ||
      payload === undefined ||
      payload.credentialId !== pending.authorization.credentialId ||
      payload.clientNonce !== pending.clientNonce ||
      payload.serverNonce !== pending.serverNonce
    ) {
      connection.close();
      return;
    }
    // WebSocket callbacks run synchronously on the mock core's event loop. Re-reading,
    // validating, consuming, minting, and persisting here forms one state mutation
    // boundary, so another proof cannot interleave with bootstrap consumption.
    const authorization = this.#reauthorizePendingChallenge(
      pending,
      Date.now(),
    );
    if (authorization === null) {
      connection.close();
      return;
    }
    const expectedClientProof = domainHmac(
      authorization.authKey,
      "paperclip-runner-client-proof-v1",
      [
        Buffer.from(pending.canonicalChallenge),
        Buffer.from(pending.serverProof),
      ],
    );
    if (!proofMatches(expectedClientProof, payload.clientProof)) {
      connection.close();
      return;
    }
    const clientProof = expectedClientProof.toString("hex");
    let leaseToken: string | null = null;
    let lease: ConnectionLeaseRecord;
    if (authorization.kind === "bootstrap") {
      authorization.ticket.usedAt = new Date().toISOString();
      leaseToken = `lease_${randomUUID()}`;
      const material = credentialMaterial(leaseToken);
      const ttlMs =
        this.fault === "lease-expiry" && !this.#faultTriggered
          ? 50
          : this.#connectionLeaseTtlMs;
      const expiresAtUnixMs = Date.now() + ttlMs;
      lease = {
        recordId: `connection_lease_record_${randomUUID()}`,
        credentialId: material.credentialId,
        authKeyDigest: `sha256:${material.authKey.toString("hex")}`,
        leaseId: `connection_lease_${randomUUID()}`,
        identity: structuredClone(this.identity),
        protocolVersion,
        expiresAt: new Date(expiresAtUnixMs).toISOString(),
        expiresAtUnixMs,
        revocationEpoch: 0,
        revokedAt: null,
      };
      this.store.state.leases[material.credentialId] = lease;
      this.store.save();
    } else {
      lease = authorization.lease;
    }
    connection.pendingChallenge = null;
    connection.lease = lease;
    connection.connectionId = `connection_${this.store.state.connectionCount + 1}`;
    connection.secureChannel = createSecureChannel(
      authorization.authKey,
      pending.canonicalChallenge,
      pending.serverProof,
      clientProof,
    );
    // A successfully authenticated reconnect is the new connection generation.
    // Retire any half-open predecessor only after the replacement proves the
    // same run-bound capability, so a network partition cannot leave two
    // authorities delivering commands concurrently.
    for (const candidate of [...this.#connections]) {
      if (candidate !== connection && candidate.secureChannel !== null) {
        candidate.close(1000);
      }
    }
    this.#welcome(connection, leaseToken);
  }

  #welcome(connection: AuthorityConnection, leaseToken: string | null): void {
    const lease = connection.lease;
    if (lease === null || connection.connectionId === null) {
      connection.close();
      return;
    }

    this.store.state.connectionCount += 1;
    this.store.state.lastLeaseId = lease.leaseId;
    this.store.state.lastLeaseExpiresAt = lease.expiresAt;

    const reportedAck = this.#replayCursorOverrideOnce
      ? Math.max(0, this.store.state.ackedSourceSeq - 1)
      : this.store.state.ackedSourceSeq;
    this.#replayCursorOverrideOnce = false;
    const suppressPending =
      !this.#faultTriggered &&
      ["socket-drop", "malformed-input", "lease-expiry"].includes(this.fault);
    const pending = suppressPending ? [] : this.#nextPendingCommand();
    for (const command of pending) {
      this.store.state.commandDeliveryCounts[command.commandId] =
        (this.store.state.commandDeliveryCounts[command.commandId] ?? 0) + 1;
    }
    this.store.save();

    connection.sendJson({
      protocol,
      version: protocolVersion,
      envelopeId: `welcome_${this.store.state.connectionCount}`,
      kind: "welcome",
      runnerInstanceId: this.identity.runnerInstanceId,
      environmentLeaseId: this.identity.environmentLeaseId,
      runId: this.identity.runId,
      normalizedSessionId: this.identity.normalizedSessionId,
      turnId: this.identity.turnId,
      itemId: this.identity.itemId,
      connectionId: connection.connectionId,
      connectionLeaseId: lease.leaseId,
      sentAt: new Date().toISOString(),
      payload: {
        selectedVersion: 1,
        heartbeatIntervalMs: 250,
        connectionLeaseId: lease.leaseId,
        ...(leaseToken === null ? {} : { connectionLeaseToken: leaseToken }),
        connectionLeaseExpiresAt: lease.expiresAt,
        connectionLeaseExpiresAtUnixMs: lease.expiresAtUnixMs,
        connectionLeaseRevocationEpoch: lease.revocationEpoch,
        leaseBinding: {
          runnerInstanceId: this.identity.runnerInstanceId,
          environmentLeaseId: this.identity.environmentLeaseId,
          runId: this.identity.runId,
          normalizedSessionId: this.identity.normalizedSessionId,
          protocolVersion,
        },
        maxFrameBytes,
        maxBatchEvents: 100,
        ackedSourceSeq: reportedAck,
        pendingCommands: pending.map(this.#wireCommand),
      },
    });

    if (suppressPending) {
      this.#triggerFault();
      if (this.fault === "malformed-input") {
        this.store.state.malformedFrames += 1;
        this.store.save();
        if (connection.wire instanceof RawWebSocketWireConnection) {
          connection.wire.sendText('{"kind":');
        } else {
          connection.wire.sendJson(null);
        }
      }
      if (this.fault === "lease-expiry") {
        lease.expiresAt = safeDate(-1);
        lease.expiresAtUnixMs = Date.now() - 1;
        this.store.state.lastLeaseExpiresAt = lease.expiresAt;
        this.store.save();
      }
      setTimeout(() => connection.close(), 5);
    }
  }

  #wireCommand(
    command: DurableRecoveryCoreCommand,
  ): Omit<DurableRecoveryCoreCommand, "status" | "result"> {
    const { status: _status, result: _result, ...wire } = command;
    return wire;
  }

  #nextPendingCommand(): DurableRecoveryCoreCommand[] {
    const command = this.store.state.commands.find(
      (candidate) => candidate.status === "pending",
    );
    return command === undefined ? [] : [command];
  }

  #controlEnvelope(
    connection: AuthorityConnection,
    envelopeId: string,
    kind: string,
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    if (connection.lease === null || connection.connectionId === null) {
      throw new Error(
        "Cannot send control data before transport authentication.",
      );
    }
    return {
      protocol,
      version: protocolVersion,
      envelopeId,
      kind,
      runnerInstanceId: this.identity.runnerInstanceId,
      environmentLeaseId: this.identity.environmentLeaseId,
      runId: this.identity.runId,
      normalizedSessionId: this.identity.normalizedSessionId,
      turnId: this.identity.turnId,
      itemId: this.identity.itemId,
      connectionId: connection.connectionId,
      connectionLeaseId: connection.lease.leaseId,
      sentAt: new Date().toISOString(),
      payload,
    };
  }

  #sendNextCommand(connection: AuthorityConnection): void {
    const [command] = this.#nextPendingCommand();
    if (command === undefined) return;
    this.store.state.commandDeliveryCounts[command.commandId] =
      (this.store.state.commandDeliveryCounts[command.commandId] ?? 0) + 1;
    this.store.save();
    connection.sendJson(
      this.#controlEnvelope(
        connection,
        `command_${command.commandId}_${this.store.state.commandDeliveryCounts[command.commandId]}`,
        "command",
        this.#wireCommand(command),
      ),
    );
  }

  #commandResult(
    connection: AuthorityConnection,
    envelope: Record<string, unknown>,
  ): void {
    const result = envelope.payload as Record<string, unknown> | undefined;
    const commandId = result?.commandId;
    if (result === undefined || typeof commandId !== "string") {
      connection.close();
      return;
    }
    const command = this.store.state.commands.find(
      (candidate) => candidate.commandId === commandId,
    );
    if (command === undefined) {
      connection.close();
      return;
    }
    if (this.fault === "duplicate-command" && !this.#faultTriggered) {
      this.#triggerFault();
      connection.close();
      return;
    }
    if (command.status !== "pending") {
      this.store.state.duplicateCommandResults += 1;
    }
    const status = result.status;
    command.status =
      status === "completed" || status === "failed" || status === "rejected"
        ? status
        : "failed";
    command.result = structuredClone(result);
    if (command.type === "run.prepare" && command.status !== "completed") {
      const blockedDetail =
        typeof result.detail === "string"
          ? result.detail
          : "provider bootstrap failed";
      for (const dependent of this.store.state.commands) {
        if (
          dependent.controllerSeq > command.controllerSeq &&
          dependent.status === "pending" &&
          (dependent.type === "session.open" || dependent.type.startsWith("turn."))
        ) {
          dependent.status = "rejected";
          dependent.result = {
            commandId: dependent.commandId,
            controllerSeq: dependent.controllerSeq,
            status: "rejected",
            logicalEffectCount: 0,
            detail: `provider bootstrap dependency failed: ${blockedDetail}`,
          };
        }
      }
    }
    if (command.status === "completed" && command.type === "run.attach") {
      this.#applyRunAttachment(command.payload);
      this.store.save();
      // The existing channel authenticated the previous immutable run
      // binding. Force the runner to reconnect using the rotated ticket/lease
      // identity before accepting any attached-run events or commands.
      this.disconnectActiveRunner();
      return;
    }
    this.store.save();
    this.#sendNextCommand(connection);
  }

  #applyRunAttachment(payload: Record<string, unknown>): void {
    const runId = payload.runId;
    const turnId = payload.turnId;
    const itemId = payload.itemId;
    if (
      typeof runId !== "string" ||
      typeof turnId !== "string" ||
      typeof itemId !== "string"
    ) {
      throw new Error("completed run.attach omitted its identity binding");
    }
    const next = { ...this.identity, runId, turnId, itemId };
    Object.assign(this.identity, next);
    this.store.state.identity = structuredClone(next);
    for (const ticket of Object.values(this.store.state.tickets)) {
      ticket.identity = structuredClone(next);
    }
    for (const lease of Object.values(this.store.state.leases)) {
      lease.identity = structuredClone(next);
    }
  }

  async #event(
    connection: AuthorityConnection,
    envelope: Record<string, unknown>,
  ): Promise<void> {
    const validated = validatePrpEvent(envelope.payload);
    if (!validated.ok) {
      connection.close();
      return;
    }
    const event = validated.event;
    const sourceSeq = event?.sourceSeq;
    const sourceEventId = event?.sourceEventId;
    const eventType = event?.eventType;
    const priority = event?.priority;
    if (
      typeof sourceSeq !== "number" ||
      typeof sourceEventId !== "string" ||
      typeof eventType !== "string" ||
      (priority !== 0 && priority !== 1 && priority !== 2) ||
      event?.sourceInstanceId !== this.identity.runnerInstanceId ||
      event.runId !== this.identity.runId ||
      event.normalizedSessionId !== this.identity.normalizedSessionId ||
      event.turnId !== this.identity.turnId
    ) {
      connection.close();
      return;
    }
    const semantic = (event.payload as Record<string, unknown> | undefined)
      ?.semantic_tool as Record<string, unknown> | undefined;
    const semanticCorrelation = semantic?.correlation as
      Record<string, unknown> | undefined;
    const isSemanticInput =
      eventType === "semantic_tool.input" || eventType === "mcp_app.tool_input";
    if (
      isSemanticInput &&
      (this.#onSemanticToolInput === undefined ||
        semantic?.phase !== "input" ||
        typeof semantic.callId !== "string" ||
        typeof semantic.operationId !== "string" ||
        !Object.prototype.hasOwnProperty.call(semantic, "input") ||
        typeof semantic.content !== "object" ||
        semantic.content === null ||
        (semantic.content as Record<string, unknown>).digest !==
          digestPaperclipSemanticContent(semantic.input) ||
        semanticCorrelation?.runId !== this.identity.runId ||
        semanticCorrelation.normalizedSessionId !==
          this.identity.normalizedSessionId ||
        semanticCorrelation.turnId !== this.identity.turnId ||
        semanticCorrelation.itemId !== this.identity.itemId)
    ) {
      connection.close();
      return;
    }
    const existing = this.store.state.committedEvents.find(
      (candidate) => candidate.sourceEventId === sourceEventId,
    );
    if (existing !== undefined) {
      if (canonicalJson(existing.envelope) !== canonicalJson(envelope)) {
        connection.close();
        return;
      }
    } else if (sourceSeq !== this.store.state.ackedSourceSeq + 1) {
      connection.close();
      return;
    }

    // The caller's durable commit is the acknowledgement authority. If the
    // process fails after that idempotent commit but before the local cursor is
    // saved, runnerd safely replays the event and only then receives its ACK.
    try {
      await this.#onCommittedEvent?.(event);
    } catch {
      connection.close();
      return;
    }

    if (existing !== undefined) {
      existing.deliveryCount += 1;
      this.store.state.replayDeliveries += 1;
    } else {
      this.store.state.committedEvents.push({
        sourceSeq,
        sourceEventId,
        eventType,
        priority,
        envelope: structuredClone(envelope),
        deliveryCount: 1,
        logicalEffectCount: 1,
      });
      this.store.state.ackedSourceSeq = sourceSeq;
    }
    this.store.save();
    if (
      isSemanticInput &&
      this.#onSemanticToolInput &&
      semantic !== undefined &&
      typeof semantic.callId === "string" &&
      typeof semantic.operationId === "string"
    ) {
      const call = {
        callId: semantic.callId,
        operationId: semantic.operationId,
        input: semantic.input,
        correlation: {
          runId: this.identity.runId,
          normalizedSessionId: this.identity.normalizedSessionId,
          turnId: this.identity.turnId,
          itemId: this.identity.itemId,
        },
        sourceEventId,
        sourceEventType: eventType,
      };
      const runScope = createHash("sha256")
        .update(this.identity.runId)
        .digest("hex")
        .slice(0, 12);
      const commandId = `command_tool_${runScope}_${call.callId}`;
      const alreadyQueued = this.store.state.commands.some(
        (command) => command.commandId === commandId,
      );
      if (!alreadyQueued && !this.#pendingSemanticCalls.has(commandId)) {
        this.#pendingSemanticCalls.add(commandId);
        void this.#onSemanticToolInput(call)
          .then((value) => {
            const outcome =
              typeof value === "object" &&
              value !== null &&
              !Array.isArray(value)
                ? (value as Record<string, unknown>)
                : {};
            const wrapped =
              outcome.__paperclipSemanticToolOutcome === true ||
              Object.prototype.hasOwnProperty.call(outcome, "result");
            const result = wrapped ? outcome.result : value;
            const isError = wrapped && outcome.isError === true;
            this.queueCommand(
              "semantic_tool.result",
              { ...call, result, isError },
              commandId,
              true,
            );
          })
          .catch(() => {
            try {
              this.queueCommand(
                "semantic_tool.result",
                {
                  ...call,
                  result: { code: "semantic_tool_bridge_failed" },
                  isError: true,
                },
                commandId,
                true,
              );
            } catch {
              this.disconnectActiveRunner();
            }
          })
          .finally(() => this.#pendingSemanticCalls.delete(commandId));
      }
    }

    if (
      this.fault === "revoke" &&
      eventType === "run.terminal" &&
      !this.#faultTriggered
    ) {
      if (connection.lease !== null) {
        connection.lease.revokedAt = new Date().toISOString();
        connection.lease.revocationEpoch += 1;
      }
      this.queueCommand(
        "turn.start",
        { turnId: this.identity.turnId, text: "must be rejected after revoke" },
        "command_after_revoke",
      );
      this.#triggerFault();
      this.store.save();
      // Revoke before ACK so the runner must flush a genuinely non-empty durable outbox.
      connection.sendJson(
        this.#controlEnvelope(connection, "revoke_durableRecovery", "revoke", {
          reason: "fault_injection_revoke",
          drain: true,
          revocationEpoch: connection.lease?.revocationEpoch,
        }),
      );
      this.#sendNextCommand(connection);
      return;
    }

    const shouldLoseAck =
      !this.#faultTriggered &&
      (this.fault === "lost-ack" || this.fault === "runner-restart");
    if (shouldLoseAck) {
      this.#replayCursorOverrideOnce = true;
      this.#triggerFault();
      if (this.fault === "lost-ack") {
        connection.close();
      }
      return;
    }

    connection.sendJson(
      this.#controlEnvelope(
        connection,
        `ack_${this.store.state.ackedSourceSeq}`,
        "ack",
        {
          ackedSourceSeq: this.store.state.ackedSourceSeq,
        },
      ),
    );
  }
}

function runnerEnvironment(
  ticket: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PAPERCLIP_RUNNER_BOOTSTRAP_TICKET: ticket,
  };
  for (const key of [
    "PATH",
    "HOME",
    "CODEX_HOME",
    "SystemRoot",
    "WINDIR",
    "PATHEXT",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "OPENROUTER_API_KEY",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET",
    "RUST_BACKTRACE",
    // AgentCore resolves an AWS profile or workload identity inside runnerd,
    // then assumes the immutable invocation role. These are locator/config
    // values, not exported access keys or session credentials.
    "AWS_PROFILE",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "AWS_CONFIG_FILE",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_ROLE_ARN",
    "AWS_ROLE_SESSION_NAME",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "PAPERCLIP_OPENCODE_COMMAND",
    "PAPERCLIP_OPENCODE_RUNTIME_DIR",
    "PAPERCLIP_RUNNER_INSTANCE_ID",
    "PAPERCLIP_RUN_ID",
    "PAPERCLIP_NORMALIZED_SESSION_ID",
    "PAPERCLIP_NATIVE_MCP_NAME",
    "PAPERCLIP_NATIVE_MCP_URL",
    "PAPERCLIP_NATIVE_MCP_TOKEN",
    "PAPERCLIP_NATIVE_RUNTIME_CONTEXT_PATH",
    // Short-lived, controller-selected sidecar capture. These never enter the
    // canonical PRP environment or provider payload; runnerd alone consumes them.
    "PAPERCLIP_PROVIDER_TRACE_PATH",
    "PAPERCLIP_PROVIDER_TRACE_MAX_BYTES",
  ]) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

export function spawnRunner(options: {
  connectUrl?: string;
  connection?: RunnerProcessConnection;
  stateDirectory: string;
  identity: DurableRecoveryIdentity;
  ticket: string;
  maxOutboxBytes: number;
  p0ReserveBytes: number;
  maxRuntimeMs?: number;
  maxLifetimeMs?: number;
  reconnectGraceMs?: number;
  lifecyclePolicy?:
    | { mode: "per_turn"; idleTimeoutMs: null }
    | { mode: "warm"; idleTimeoutMs: number };
  runnerBinaryPath?: string;
  environment?: NodeJS.ProcessEnv;
  processLauncher?: (spec: RunnerProcessLaunchSpec) => RunnerProcessHandle;
}): RunnerProcessHandle {
  const connection =
    options.connection ??
    (options.connectUrl
      ? { mode: "connect" as const, connectUrl: options.connectUrl }
      : null);
  if (!connection) throw new Error("runner process connection is required");
  const connectionArgs =
    connection.mode === "connect"
      ? [
          "--connect-url",
          connection.connectUrl,
          ...(connection.caBundlePath
            ? ["--ca-bundle-path", connection.caBundlePath]
            : []),
        ]
      : [
          "--listen-address",
          connection.listenAddress,
          "--listen-port",
          String(connection.listenPort),
          "--listen-path",
          connection.listenPath,
        ];
  const args = [
    ...connectionArgs,
    "--state-dir",
    options.stateDirectory,
    "--runner-id",
    options.identity.runnerInstanceId,
    "--environment-lease-id",
    options.identity.environmentLeaseId,
    "--run-id",
    options.identity.runId,
    "--session-id",
    options.identity.normalizedSessionId,
    "--turn-id",
    options.identity.turnId,
    "--item-id",
    options.identity.itemId,
    "--runner-version",
    "0.3.0",
    "--runner-digest",
    "sha256:durable-recovery-approved",
    "--fake-harness",
    fakeHarnessBinary,
    "--fake-harness-script",
    fakeHarnessScript,
    "--max-outbox-bytes",
    String(options.maxOutboxBytes),
    "--p0-reserve-bytes",
    String(options.p0ReserveBytes),
    "--reconnect-delay-ms",
    "250",
  ];
  if (options.maxLifetimeMs !== undefined) {
    args.push("--max-lifetime-ms", String(options.maxLifetimeMs));
  } else if (options.maxRuntimeMs !== undefined) {
    args.push("--max-runtime-ms", String(options.maxRuntimeMs));
  }
  if (options.reconnectGraceMs !== undefined) {
    args.push("--reconnect-grace-ms", String(options.reconnectGraceMs));
  }
  if (options.lifecyclePolicy !== undefined) {
    args.push("--lifecycle-mode", options.lifecyclePolicy.mode);
    if (options.lifecyclePolicy.mode === "warm") {
      args.push(
        "--idle-timeout-ms",
        String(options.lifecyclePolicy.idleTimeoutMs),
      );
    }
  }
  const command = options.runnerBinaryPath ?? runnerBinary;
  const environment = runnerEnvironment(options.ticket, options.environment);
  const withRestart = (handle: RunnerProcessHandle): RunnerProcessHandle => ({
    ...handle,
    restart: (ticket) => spawnRunner({ ...options, ticket }),
  });
  if (options.processLauncher) {
    return withRestart(
      options.processLauncher({
        command,
        args,
        cwd: packageRoot,
        environment,
      }),
    );
  }
  const child = spawn(command, args, {
    cwd: packageRoot,
    env: environment,
    stdio: "pipe",
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout = `${stdout}${chunk}`.slice(-16_384);
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-16_384);
  });
  const completion = new Promise<RunnerProcessResult>(
    (resolveCompletion, rejectCompletion) => {
      child.once("error", rejectCompletion);
      child.once("exit", (code, signal) =>
        resolveCompletion({ code, signal, stdout, stderr }),
      );
    },
  );
  return withRestart({ child, completion });
}

export async function waitForProcess(
  handle: RunnerProcessHandle,
  timeoutMs = 15_000,
): Promise<RunnerProcessResult> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      handle.completion,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          handle.child.kill("SIGKILL");
          reject(new Error("Durable recovery runner timed out."));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Test-fixture compatibility wrapper that requires an explicit injected fault mode. */
export class DurableRecoveryMockCore extends DurablePrpControlPlane {
  constructor(
    options: DurablePrpControlPlaneOptions & { fault: DurableRecoveryFault },
  ) {
    super(options);
  }
}

function durableRecoveryIdentity(): DurableRecoveryIdentity {
  return {
    runnerInstanceId: "runner_durableRecovery_stable",
    environmentLeaseId: "environment_lease_durableRecovery_stable",
    runId: "run_durableRecovery_stable",
    normalizedSessionId: "session_durableRecovery_stable",
    turnId: "turn_durableRecovery_stable",
    itemId: "item_durableRecovery_stable",
  };
}

function queueScenario(
  core: DurableRecoveryMockCore,
  fault: DurableRecoveryFault,
): void {
  core.queueCommand("run.prepare", {
    workspace: "durable-recovery-durable-fixture",
  });
  core.queueCommand("session.open", { reuse: "same_session" });
  if (fault === "harness-restart") {
    core.queueCommand("fault.harness_restart", {});
  }
  if (fault === "storage-pressure") {
    core.queueCommand("fault.storage_pressure", {});
  }
  if (fault === "drain") {
    core.queueCommand("runner.drain", {});
  }
  core.queueCommand("turn.start", {
    turnId: core.identity.turnId,
    text: "Prove Durable recovery.",
  });
  if (fault !== "revoke") {
    core.queueCommand("runner.shutdown", {});
  }
}

function readRunnerState(stateDirectory: string): DurableRecoveryRunnerState {
  return JSON.parse(
    readFileSync(resolve(stateDirectory, "runner-state.json"), "utf8"),
  ) as DurableRecoveryRunnerState;
}

function assertContinuous(
  events: readonly DurableRecoveryCommittedEvent[],
): boolean {
  return events
    .toSorted((left, right) => left.sourceSeq - right.sourceSeq)
    .every((event, index) => event.sourceSeq === index + 1);
}

function secretLeakCount(
  paths: readonly string[],
  secrets: readonly string[],
): number {
  let leaks = 0;
  for (const path of paths) {
    const source = readFileSync(path, "utf8");
    for (const secret of secrets) {
      if (secret.length > 0 && source.includes(secret)) leaks += 1;
    }
  }
  return leaks;
}

function persistedCapabilityShape(
  path: string,
  fieldNames: readonly string[],
): boolean {
  const source = readFileSync(path, "utf8");
  return fieldNames.some((fieldName) => source.includes(`\"${fieldName}\"`));
}

export interface RunDurableRecoveryRecoveryOptions {
  fault?: DurableRecoveryFault;
  stateDirectory?: string;
  keepState?: boolean;
}

export interface DurableToolBridgeConformanceResult {
  operationId: string;
  callId: string;
  toolInputCommitted: boolean;
  toolResultCompleted: boolean;
  providerTurnCompleted: boolean;
  runnerExitCode: number | null;
}

export interface DurableToolBridgeConformanceOptions {
  realCodex?: boolean;
  model?: string;
}

/** Proves provider -> runnerd -> control plane -> runnerd -> provider with no TS sandbox dispatcher. */
export async function runDurableToolBridgeConformance(
  options: DurableToolBridgeConformanceOptions = {},
): Promise<DurableToolBridgeConformanceResult> {
  const identity = durableRecoveryIdentity();
  const root = mkdtempSync(resolve(tmpdir(), "paperclip-runner-tool-bridge-"));
  const runnerStateDirectory = resolve(root, "runner");
  mkdirSync(runnerStateDirectory, { recursive: true, mode: 0o700 });
  const authority = new CapabilityMockControlPlaneAdapter({
    actors: [
      {
        id: "actor-1",
        companyId: "company-1",
        name: "Bridge agent",
        role: "engineer",
        status: "active",
        budgetId: "budget-1",
        capabilityGrants: [],
      },
    ],
  });
  await authority.start();
  await authority.openFixtureRun({
    identity: {
      runId: identity.runId,
      sessionId: identity.normalizedSessionId,
      companyId: "company-1",
      issueId: "task-1",
      agentId: "actor-1",
    },
    backendKind: "mock",
    sourceInstanceId: "durable-tool-bridge",
    capabilities: [],
  });
  const dispatcher = new CapabilitySemanticDispatcher(authority);
  const core = new DurableRecoveryMockCore({
    stateDirectory: resolve(root, "mock-core"),
    identity,
    fault: "none",
    onSemanticToolInput: (call) =>
      dispatcher.dispatch({ runId: identity.runId, ...call }),
  });
  const authorized = dispatcher.listTools(identity.runId);
  const operations: Array<{
    operationId: string;
    version: number;
    description: string;
    inputSchema: unknown;
    responseSchema: unknown;
  }> = authorized.map((tool) => {
    const descriptor = capabilitySemanticToolDescriptor(tool.name);
    if (!descriptor) throw new Error(`missing descriptor for ${tool.name}`);
    return {
      operationId: tool.name,
      version: 1,
      description: tool.description,
      inputSchema: tool.inputSchema,
      responseSchema: descriptor.outputSchema,
    };
  });
  const catalogDigest = `sha256:${createHash("sha256").update(canonicalJson(operations)).digest("hex")}`;
  const providerCommand = options.realCodex
    ? (process.env.PAPERCLIP_CODEX_COMMAND ?? "codex")
    : fakeCodexBinary;
  const providerArgs = options.realCodex
    ? [
        "-c",
        'default_permissions="paperclip-runner-workspace-only"',
        "-c",
        `permissions.paperclip-runner-workspace-only.filesystem={":root"="none",":minimal"="read",":tmpdir"="write",${JSON.stringify(tmpdir())}="write"}`,
        "-c",
        "permissions.paperclip-runner-workspace-only.network.enabled=false",
        "-c",
        'shell_environment_policy.inherit="none"',
        "app-server",
      ]
    : [];
  core.queueCommand("run.prepare", {
    authorizedTools: {
      schema: "paperclip.runner.authorized-tools.v1",
      schemaVersion: 1,
      catalogDigest,
      operations,
    },
    provider: {
      command: providerCommand,
      args: providerArgs,
      cwd: tmpdir(),
      model: options.model ?? null,
      instructions:
        "You are in a Paperclip protocol conformance run. Call get_task_context exactly once, use its result, then reply briefly. Do not use shell or filesystem tools.",
    },
  });
  core.queueCommand("session.open", { reuse: "same_session" });
  core.queueCommand("turn.start", {
    text: "Call get_task_context now and report the task title.",
  });
  await core.start();
  const ticket = core.issueBootstrapTicket();
  const handle = spawnRunner({
    connectUrl: core.connectUrl,
    stateDirectory: runnerStateDirectory,
    identity,
    ticket,
    maxOutboxBytes: 64 * 1024,
    p0ReserveBytes: 32 * 1024,
    maxRuntimeMs: options.realCodex ? 180_000 : 10_000,
  });
  let callId = "";
  let operationId = "";
  try {
    const deadline = Date.now() + (options.realCodex ? 150_000 : 10_000);
    while (Date.now() < deadline) {
      const input = core.store.state.committedEvents.find(
        (event) =>
          event.eventType === "semantic_tool.input" ||
          event.eventType === "mcp_app.tool_input",
      );
      const semantic = (
        (input?.envelope.payload as Record<string, unknown> | undefined)
          ?.payload as Record<string, unknown> | undefined
      )?.semantic_tool as Record<string, unknown> | undefined;
      if (
        semantic &&
        typeof semantic.callId === "string" &&
        typeof semantic.operationId === "string"
      ) {
        callId = semantic.callId;
        operationId = semantic.operationId;
        break;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    if (!callId)
      throw new Error("runnerd did not forward the provider tool call");
    const resultDeadline = Date.now() + 10_000;
    while (Date.now() < resultDeadline) {
      const resultCommand = core.store.state.commands.find(
        (command) => command.type === "semantic_tool.result",
      );
      const turnCompleted = core.store.state.committedEvents.some(
        (event) => event.eventType === "turn.completed",
      );
      if (resultCommand?.status === "completed" && turnCompleted) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    core.queueCommand("runner.shutdown", {}, undefined, true);
    const exited = await waitForProcess(handle);
    const resultCommand = core.store.state.commands.find(
      (command) => command.type === "semantic_tool.result",
    );
    return {
      operationId,
      callId,
      toolInputCommitted: true,
      toolResultCompleted: resultCommand?.status === "completed",
      providerTurnCompleted: core.store.state.committedEvents.some(
        (event) => event.eventType === "turn.completed",
      ),
      runnerExitCode: exited.code,
    };
  } finally {
    handle.child.kill("SIGKILL");
    await core.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

export interface DurableEvalSessionInput {
  attemptId: string;
  prompt: string;
  model: string;
  runnerBinaryPath: string;
  seed: CapabilityFixtureSeed;
  actorId: string;
  taskId: string;
  capabilities: string[];
  explicitClaims: string[];
  turnTimeoutMs: number;
  toolExposure?: "eager" | "lazy";
  /** Crash Runner D after this semantic input commits, then resume it natively. */
  nativeResume?: { operationId: string };
  /** Test-only provider process override; production eval callers omit these. */
  providerCommand?: string;
  providerArgs?: string[];
  /** Test-only shared Codex server override; production eval callers omit these. */
  sharedProviderCommand?: string;
  sharedProviderArgs?: string[];
  sharedProviderSocketPath?: string;
  /** Defaults on for Codex; set false only for an eval that needs the baseline prompt. */
  includeCollaborationModeInstructions?: boolean;
  provider?: "codex" | "opencode" | "claude_managed" | "aws_agentcore" | "acpx";
  acpxAgent?: QualifiedAcpxAgent;
  acpxPermissionMode?: "approve-all" | "approve-reads" | "deny-all";
  acpxSidecarPath?: string;
  opencodeVersion?: string;
  opencodeCommand?: string;
  opencodeProxyPath?: string;
  managedProfile?: {
    profileId: string;
    anthropicAgentId: string;
    agentVersion: string;
    environmentId: string;
    betaVersion: "managed-agents-2026-04-01";
    maxSessionListCostUsd: number;
  };
  agentCoreProfile?: {
    profileId: string;
    region: string;
    accountId: string;
    harnessArn: string;
    harnessVersion: string;
    endpointArn: string;
    endpointQualifier: string;
    agentRuntimeArn: string;
    memoryArn: string;
    memoryId: string;
    invocationRoleArn: string;
    contextBucket: string;
    contextPrefix: string;
    contextKmsKeyArn: string;
    qualificationRevision: string;
    eventExpiryDays: 90;
    maxEstimatedSessionCostUsd: number;
    maxIterations: number;
    maxOutputTokens: number;
    timeoutSeconds: number;
  };
}

export type DurableEvalInfrastructureFailureClass =
  | "provider_turn_timeout"
  | "provider_budget_reached"
  | "runner_shutdown_timeout"
  | "runner_exit_failure";

export class DurableEvalInfrastructureError extends Error {
  readonly failureClass: DurableEvalInfrastructureFailureClass;
  readonly retryable: boolean;
  readonly diagnostics: Record<string, unknown>;

  constructor(
    failureClass: DurableEvalInfrastructureFailureClass,
    message: string,
    retryable: boolean,
    diagnostics: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DurableEvalInfrastructureError";
    this.failureClass = failureClass;
    this.retryable = retryable;
    this.diagnostics = diagnostics;
  }
}

function evalLifecycleDiagnostics(
  core: DurableRecoveryMockCore,
  handle: RunnerProcessHandle,
  runnerStateDirectory?: string,
): Record<string, unknown> {
  const commands = core.store.state.commands.map((command) => ({
    commandId: command.commandId,
    type: command.type,
    status: command.status,
    deliveryCount:
      core.store.state.commandDeliveryCounts[command.commandId] ?? 0,
  }));
  const events = core.store.state.committedEvents.slice(-20).map((event) => ({
    sourceSeq: event.sourceSeq,
    eventType: event.eventType,
    priority: event.priority,
    deliveryCount: event.deliveryCount,
  }));
  let runnerDiagnostics: unknown[] = [];
  if (runnerStateDirectory) {
    try {
      const state = JSON.parse(
        readFileSync(
          resolve(runnerStateDirectory, "runner-state.json"),
          "utf8",
        ),
      ) as { diagnostics?: unknown[] };
      runnerDiagnostics = Array.isArray(state.diagnostics)
        ? state.diagnostics.slice(-20)
        : [];
    } catch {
      // A runner that failed before its first durable save has no state diagnostics.
    }
  }
  let providerDescriptor: Record<string, unknown> | null = null;
  let usageRunDelta: Record<string, unknown> | null = null;
  for (
    let index = core.store.state.committedEvents.length - 1;
    index >= 0;
    index -= 1
  ) {
    const event = core.store.state.committedEvents[index]?.envelope.payload as
      Record<string, unknown> | undefined;
    const payload = event?.payload as Record<string, unknown> | undefined;
    if (usageRunDelta === null && event?.eventType === "usage.reported") {
      const candidate = payload?.runDelta;
      if (
        typeof candidate === "object" &&
        candidate !== null &&
        !Array.isArray(candidate)
      ) {
        usageRunDelta = structuredClone(candidate as Record<string, unknown>);
      }
    }
    if (providerDescriptor === null && event?.eventType === "harness.ready") {
      const candidate = payload?.providerDescriptor;
      if (
        typeof candidate === "object" &&
        candidate !== null &&
        !Array.isArray(candidate)
      ) {
        providerDescriptor = structuredClone(
          candidate as Record<string, unknown>,
        );
      }
    }
    if (providerDescriptor !== null && usageRunDelta !== null) break;
  }
  return {
    runnerPid: handle.child.pid ?? null,
    runnerExitCode: handle.child.exitCode,
    runnerSignal: handle.child.signalCode,
    connectionCount: core.store.state.connectionCount,
    ackedSourceSeq: core.store.state.ackedSourceSeq,
    commands,
    recentEvents: events,
    runnerDiagnostics,
    providerDescriptor,
    providerSessionId:
      typeof providerDescriptor?.providerSessionId === "string"
        ? providerDescriptor.providerSessionId
        : null,
    usageRunDelta,
  };
}

function projectedSemanticResult(
  operationId: unknown,
  result: unknown,
): unknown {
  if (operationId !== "invoke_discovered_capability") return result;
  const contentItems = (result as { contentItems?: unknown } | null)
    ?.contentItems;
  if (!Array.isArray(contentItems)) return result;
  for (const item of contentItems) {
    const text = (item as { text?: unknown } | null)?.text;
    if (typeof text !== "string") continue;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // Preserve the bounded gateway response when its content is not JSON.
    }
  }
  return result;
}

function claudeManagedEvalProviderConfiguration(
  model: string,
  profile: NonNullable<DurableEvalSessionInput["managedProfile"]>,
): Record<string, unknown> {
  return {
    kind: "claude_managed",
    model,
    profileId: profile.profileId,
    anthropicAgentId: profile.anthropicAgentId,
    agentVersion: profile.agentVersion,
    environmentId: profile.environmentId,
    betaVersion: profile.betaVersion,
    maxSessionListCostUsd: profile.maxSessionListCostUsd,
  };
}

function managedProviderBudgetReached(
  events: readonly { envelope: Record<string, unknown> }[],
): boolean {
  return events.some((committed) => {
    const event = committed.envelope.payload as
      Record<string, unknown> | undefined;
    if (event?.eventType !== "session.updated") return false;
    const payload = event.payload as Record<string, unknown> | undefined;
    return payload?.status === "budget_reached";
  });
}

function sanitizedAwsEvalEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "RUST_BACKTRACE",
    "AWS_PROFILE",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "AWS_CONFIG_FILE",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_ROLE_ARN",
    "AWS_ROLE_SESSION_NAME",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  ]) {
    if (typeof source[key] === "string") result[key] = source[key];
  }
  return result;
}

/** Production-topology eval: the only Paperclip process in the sandbox is runnerd. */
export async function runDurableEvalSession(
  input: DurableEvalSessionInput,
): Promise<Record<string, unknown>> {
  if (
    input.nativeResume !== undefined &&
    (input.provider ?? "codex") !== "codex"
  ) {
    throw new Error("native resume eval requires the Codex provider");
  }
  const identity = {
    runnerInstanceId: `runner_${createHash("sha256").update(input.attemptId).digest("hex").slice(0, 16)}`,
    environmentLeaseId: `lease_${createHash("sha256").update(`${input.attemptId}:lease`).digest("hex").slice(0, 16)}`,
    runId: input.attemptId,
    normalizedSessionId: `session_${createHash("sha256").update(`${input.attemptId}:session`).digest("hex").slice(0, 16)}`,
    turnId: `turn_${createHash("sha256").update(`${input.attemptId}:turn`).digest("hex").slice(0, 16)}`,
    itemId: `item_${createHash("sha256").update(`${input.attemptId}:item`).digest("hex").slice(0, 16)}`,
  };
  const root = mkdtempSync(resolve(tmpdir(), "paperclip-runner-live-eval-"));
  const runnerStateDirectory = resolve(root, "runner");
  mkdirSync(runnerStateDirectory, { recursive: true, mode: 0o700 });
  const authority = new CapabilityMockControlPlaneAdapter(input.seed);
  const initialState = JSON.stringify(authority.snapshot());
  await authority.start();
  const companyId =
    authority.snapshot().actors.find((actor) => actor.id === input.actorId)
      ?.companyId ?? "company-1";
  await authority.openFixtureRun({
    identity: {
      runId: identity.runId,
      sessionId: identity.normalizedSessionId,
      companyId,
      issueId: input.taskId,
      agentId: input.actorId,
    },
    backendKind: "mock",
    sourceInstanceId: identity.runnerInstanceId,
    capabilities: input.capabilities,
  });
  const dispatcher = new CapabilitySemanticDispatcher(authority, {
    scenario: { id: input.attemptId, claims: input.capabilities },
    explicitClaims: input.explicitClaims,
  });
  const authorized = dispatcher.listTools(identity.runId);
  const loadedOperations = new Set<string>();
  const discoveryEvidence: Array<Record<string, unknown>> = [];
  type NativeResumeCall = {
    callId: string;
    operationId: string;
    input: unknown;
  };
  let nativeResumeCall: NativeResumeCall | null = null;
  let releaseNativeSemanticDispatch!: () => void;
  const nativeSemanticDispatchReleased = new Promise<void>(
    (resolveDispatch) => {
      releaseNativeSemanticDispatch = resolveDispatch;
    },
  );
  let nativeSemanticHandlerCallCount = 0;
  const operations: Array<{
    operationId: string;
    version: number;
    description: string;
    inputSchema: unknown;
    responseSchema: unknown;
  }> = authorized.map((tool) => {
    const descriptor = capabilitySemanticToolDescriptor(tool.name);
    if (!descriptor) throw new Error(`missing descriptor for ${tool.name}`);
    return {
      operationId: tool.name,
      version: 1,
      description: tool.description,
      inputSchema: tool.inputSchema,
      responseSchema: descriptor.outputSchema,
    };
  });
  const exposedOperations =
    input.toolExposure === "lazy"
      ? operations.filter(
          (operation) =>
            authorized.find((tool) => tool.name === operation.operationId)
              ?.annotations.exposure === "always",
        )
      : operations;
  if (input.toolExposure === "lazy") {
    exposedOperations.push(
      ...CAPABILITY_DISCOVERY_GATEWAY_DEFINITIONS.map((gateway) => ({
        operationId: gateway.name,
        version: 1,
        description: gateway.description,
        inputSchema: gateway.inputSchema,
        responseSchema: gateway.outputSchema,
      })),
    );
  }
  const core = new DurableRecoveryMockCore({
    stateDirectory: resolve(root, "mock-core"),
    identity,
    fault: "none",
    onSemanticToolInput: async (call) => {
      if (call.operationId === "discover_capabilities") {
        const args = (call.input ?? {}) as Record<string, unknown>;
        const found = dispatcher.discoverTools(
          identity.runId,
          String(args.query ?? ""),
          {
            ...(typeof args.namespace === "string"
              ? { namespace: args.namespace }
              : {}),
            ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
          },
        );
        for (const operation of found.operations)
          loadedOperations.add(operation.name);
        discoveryEvidence.push({
          action: "loaded",
          query: found.query,
          namespace: found.namespace ?? "",
          operationIds: found.operations.map((operation) => operation.name),
        });
        return found;
      }
      if (call.operationId === "invoke_discovered_capability") {
        const args = (call.input ?? {}) as Record<string, unknown>;
        const operationId = String(args.operationId ?? "");
        if (!loadedOperations.has(operationId))
          return {
            ok: false,
            denial: {
              code: "operation_not_loaded",
              message: "Operation was not loaded by capability discovery.",
            },
          };
        const invoked = await dispatcher.dispatch({
          runId: identity.runId,
          callId: call.callId,
          operationId,
          input: args.input,
        });
        return {
          success: invoked.ok,
          contentItems: [{ type: "inputText", text: JSON.stringify(invoked) }],
        };
      }
      if (call.operationId === input.nativeResume?.operationId) {
        nativeResumeCall ??= structuredClone(call);
        await nativeSemanticDispatchReleased;
        nativeSemanticHandlerCallCount += 1;
      }
      return dispatcher.dispatch({ runId: identity.runId, ...call });
    },
    // The connection lease is an ownership/security boundary, not a provider-turn
    // deadline. ACP turns are handled synchronously by runnerd today, so a slow
    // provider cannot receive runner.shutdown until the turn returns. Keep the
    // eval lease aligned with the production live transport and let the separate
    // turn timeout classify/cancel provider work without invalidating otherwise
    // durable evidence during shutdown.
    connectionLeaseTtlMs: durableEvalConnectionLeaseTtlMs(input.turnTimeoutMs),
  });
  const providerArgs = [
    "-c",
    'default_permissions="paperclip-runner-workspace-only"',
    "-c",
    `permissions.paperclip-runner-workspace-only.filesystem={":root"="none",":minimal"="read",":tmpdir"="write",${JSON.stringify(tmpdir())}="write"}`,
    "-c",
    "permissions.paperclip-runner-workspace-only.network.enabled=false",
    "-c",
    'shell_environment_policy.inherit="none"',
    "app-server",
  ];
  const providerKind = input.provider ?? "codex";
  if (providerKind === "claude_managed" && input.managedProfile === undefined) {
    throw new Error(
      "Claude Managed eval requires an immutable managed profile snapshot",
    );
  }
  if (
    providerKind === "aws_agentcore" &&
    input.agentCoreProfile === undefined
  ) {
    throw new Error(
      "AWS AgentCore eval requires an immutable qualified profile snapshot",
    );
  }
  const opencodeProxyPath =
    input.opencodeProxyPath ??
    fileURLToPath(
      new URL("../cli/opencode-app-server-proxy.js", import.meta.url),
    );
  const acpxSidecarPath =
    input.acpxSidecarPath ??
    fileURLToPath(new URL("../cli/acpx-runtime-sidecar.js", import.meta.url));
  const codexUnixProxyPath = fileURLToPath(
    new URL("../cli/codex-app-server-unix-proxy.js", import.meta.url),
  );
  if (providerKind === "acpx" && input.acpxAgent === "pi") {
    throw new Error("The Pi ACPX profile is not available");
  }
  const acpxProfile =
    providerKind === "acpx"
      ? resolveQualifiedAcpxProfile(input.acpxAgent ?? "codex", input.model)
      : null;
  const sharedCodexSocket =
    input.sharedProviderSocketPath ?? resolve(root, "c.sock");
  const codexConfigArgs = providerArgs.slice(0, -1);
  const effectiveProviderArgs =
    input.providerArgs ??
    (input.nativeResume === undefined
      ? providerArgs
      : [codexUnixProxyPath, "--socket", sharedCodexSocket]);
  let sharedCodexServer: ChildProcessWithoutNullStreams | null = null;
  let sharedCodexServerStderr = "";
  let sharedCodexServerError: Error | null = null;
  core.queueCommand("run.prepare", {
    authorizedTools: {
      schema: "paperclip.runner.authorized-tools.v1",
      schemaVersion: 1,
      catalogDigest: `sha256:${createHash("sha256").update(canonicalJson(operations)).digest("hex")}`,
      operations: exposedOperations,
    },
    provider:
      providerKind === "claude_managed"
        ? claudeManagedEvalProviderConfiguration(
            input.model,
            input.managedProfile!,
          )
        : providerKind === "aws_agentcore"
          ? {
              kind: "aws_agentcore",
              model: input.model,
              ...input.agentCoreProfile,
            }
          : providerKind === "acpx"
            ? {
                kind: "acpx",
                agent: acpxProfile!.agent,
                model: input.model,
                acpxVersion: acpxProfile!.acpxVersion,
                agentServerPackage: acpxProfile!.agentServerPackage,
                agentServerVersion: acpxProfile!.agentServerVersion,
                agentRuntimePackage: acpxProfile!.agentRuntimePackage,
                agentRuntimeVersion: acpxProfile!.agentRuntimeVersion,
                commandDigest: acpxProfile!.commandDigest,
                sidecarCommand: process.execPath,
                sidecarArgs: [acpxSidecarPath],
                runtimeDirectory: resolve(root, "acpx"),
                normalizedSessionId: identity.normalizedSessionId,
                runId: identity.runId,
                cwd: tmpdir(),
                instructions:
                  "You are a Paperclip agent. Use only the supplied Paperclip tools for company state. Follow the user request, then reply concisely. Do not use shell or filesystem tools.",
                permissionMode: input.acpxPermissionMode ?? "approve-all",
                permissionModePinned: true,
              }
            : {
                kind: providerKind,
                command:
                  input.providerCommand ??
                  (input.nativeResume !== undefined
                    ? process.execPath
                    : providerKind === "opencode"
                      ? process.execPath
                      : (process.env.PAPERCLIP_CODEX_COMMAND ?? "codex")),
                args:
                  input.providerArgs ??
                  (providerKind === "opencode"
                    ? [opencodeProxyPath]
                    : effectiveProviderArgs),
                cwd: tmpdir(),
                model: input.model,
                approvalPolicy: "never",
                instructions:
                  "You are a Paperclip agent. Use only the supplied Paperclip tools for company state. Follow the user request, then reply concisely. Do not use shell or filesystem tools.",
                collaborationMode: "default",
                includeCollaborationModeInstructions:
                  providerKind === "codex" &&
                  (input.includeCollaborationModeInstructions ?? true),
              },
  });
  core.queueCommand("session.open", { reuse: "same_session" });
  core.queueCommand("turn.start", { text: input.prompt });
  await core.start();
  if (input.nativeResume !== undefined) {
    const sharedCommand =
      input.sharedProviderCommand ??
      input.providerCommand ??
      process.env.PAPERCLIP_CODEX_COMMAND ??
      "codex";
    const sharedArgs = input.sharedProviderArgs ?? [
      ...codexConfigArgs,
      "app-server",
      "--listen",
      `unix://${sharedCodexSocket}`,
    ];
    sharedCodexServer = spawn(sharedCommand, sharedArgs, {
      cwd: tmpdir(),
      env: process.env,
      stdio: "pipe",
    });
    sharedCodexServer.stdout.resume();
    sharedCodexServer.once("error", (error) => {
      sharedCodexServerError = error;
    });
    sharedCodexServer.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      sharedCodexServerStderr = `${sharedCodexServerStderr}${chunk}`.slice(
        -16_384,
      );
    });
    const sharedServerDeadline = Date.now() + 10_000;
    while (
      !existsSync(sharedCodexSocket) &&
      sharedCodexServerError === null &&
      sharedCodexServer.exitCode === null &&
      Date.now() < sharedServerDeadline
    ) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    if (!existsSync(sharedCodexSocket)) {
      sharedCodexServer.kill("SIGKILL");
      const startError = sharedCodexServerError as Error | null;
      throw new Error(
        `shared Codex app-server did not create its socket: ${startError?.message ?? sharedCodexServerStderr}`,
      );
    }
  }
  const launchRunner = (): RunnerProcessHandle =>
    spawnRunner({
      connectUrl: core.connectUrl,
      stateDirectory: runnerStateDirectory,
      identity,
      ticket: core.issueBootstrapTicket(),
      maxOutboxBytes: 256 * 1024,
      p0ReserveBytes: 64 * 1024,
      maxRuntimeMs: input.turnTimeoutMs + 30_000,
      runnerBinaryPath: input.runnerBinaryPath,
      environment:
        providerKind === "opencode"
          ? {
              ...process.env,
              PAPERCLIP_OPENCODE_COMMAND: input.opencodeCommand ?? "opencode",
              PAPERCLIP_OPENCODE_RUNTIME_DIR: resolve(root, "opencode"),
              PAPERCLIP_RUNNER_INSTANCE_ID: identity.runnerInstanceId,
              PAPERCLIP_RUN_ID: identity.runId,
              PAPERCLIP_NORMALIZED_SESSION_ID: identity.normalizedSessionId,
            }
          : providerKind === "claude_managed"
            ? createSanitizedClaudeManagedEnvironment(process.env)
            : providerKind === "aws_agentcore"
              ? sanitizedAwsEvalEnvironment(process.env)
              : providerKind === "acpx"
                ? createSanitizedAcpxEnvironment(
                    process.env,
                    acpxProfile!.agent,
                  )
                : process.env,
    });
  let handle = launchRunner();
  const runnerProcessPids = [handle.child.pid].filter(
    (pid): pid is number => typeof pid === "number",
  );
  let runnerRestarts = 0;
  let crashedRunner: RunnerProcessResult | null = null;
  try {
    const resolvedEvalRuntimeRequests = new Set<string>();
    let providerTerminalFailure: {
      failureClass: "provider_turn_timeout" | "provider_budget_reached";
      message: string;
      retryable: boolean;
    } | null = null;
    const deadline = Date.now() + input.turnTimeoutMs;
    if (input.nativeResume !== undefined) {
      while (nativeResumeCall === null && Date.now() < deadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
      if (nativeResumeCall === null) {
        handle.child.kill("SIGKILL");
        const timedOutRunner = await handle.completion;
        const diagnostics =
          timedOutRunner.stderr.trim() ||
          sharedCodexServerStderr.trim() ||
          "no process diagnostics";
        throw new Error(
          `native resume operation ${input.nativeResume.operationId} did not commit before timeout: ${diagnostics}`,
        );
      }
      handle.child.kill("SIGKILL");
      crashedRunner = await waitForProcess(handle, 10_000);
      if (crashedRunner.signal !== "SIGKILL") {
        throw new Error(
          `native resume runner exited with ${String(crashedRunner.signal)}`,
        );
      }
      runnerRestarts = 1;
      handle = launchRunner();
      if (typeof handle.child.pid === "number")
        runnerProcessPids.push(handle.child.pid);
      // TypeScript cannot infer assignment performed in the async dispatch callback.
      const pendingCall = nativeResumeCall as NativeResumeCall;
      const pendingCallWasReconciled = (): boolean =>
        core.store.state.committedEvents.some((event) => {
          if (event.eventType !== "semantic_tool.reconciled") return false;
          const payload = (
            event.envelope.payload as Record<string, unknown> | undefined
          )?.payload as Record<string, unknown> | undefined;
          const semantic = payload?.semantic_tool as
            Record<string, unknown> | undefined;
          return (
            semantic?.callId === pendingCall.callId &&
            semantic?.operationId === pendingCall.operationId
          );
        });
      while (Date.now() < deadline) {
        if (pendingCallWasReconciled()) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
      if (!pendingCallWasReconciled()) {
        throw new Error(
          "replacement Runner D did not reconcile the pending Codex tool call",
        );
      }
      releaseNativeSemanticDispatch();
    }
    while (Date.now() < deadline) {
      if (providerKind === "acpx") {
        for (const committed of core.store.state.committedEvents) {
          const event = committed.envelope.payload as
            Record<string, unknown> | undefined;
          if (event?.eventType !== "runtime_request.created") continue;
          const payload = event.payload as Record<string, unknown> | undefined;
          const request = payload?.request as
            Record<string, unknown> | undefined;
          const requestId =
            typeof request?.requestId === "string" ? request.requestId : "";
          const requestTurnId =
            typeof request?.turnId === "string"
              ? request.turnId
              : identity.turnId;
          if (!requestId || resolvedEvalRuntimeRequests.has(requestId))
            continue;
          resolvedEvalRuntimeRequests.add(requestId);
          core.queueCommand(
            "request.resolve",
            {
              requestId,
              turnId: requestTurnId,
              resolution: { action: "decline" },
            },
            `command_eval_permission_${createHash("sha256").update(requestId).digest("hex").slice(0, 16)}`,
            true,
          );
        }
      }
      const budgetReached =
        providerKind === "claude_managed" &&
        managedProviderBudgetReached(core.store.state.committedEvents);
      if (budgetReached) {
        providerTerminalFailure = {
          failureClass: "provider_budget_reached",
          message: `Claude Managed session reached its $${input.managedProfile!.maxSessionListCostUsd.toFixed(2)} provider list-cost ceiling`,
          retryable: false,
        };
        break;
      }
      if (
        core.store.state.committedEvents.some(
          (event) => event.eventType === "turn.completed",
        )
      )
        break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    if (
      providerTerminalFailure === null &&
      !core.store.state.committedEvents.some(
        (event) => event.eventType === "turn.completed",
      )
    ) {
      providerTerminalFailure = {
        failureClass: "provider_turn_timeout",
        message: `durable provider turn timed out after ${input.turnTimeoutMs}ms`,
        retryable: true,
      };
    }
    // Managed sessions are retained by normal runner shutdown. Never issue
    // session.destroy from the eval lane, including timeout and budget stops.
    core.queueCommand("runner.shutdown", {}, undefined, true);
    let exited: RunnerProcessResult;
    try {
      exited = await waitForProcess(handle, 30_000);
    } catch (error) {
      throw new DurableEvalInfrastructureError(
        "runner_shutdown_timeout",
        `runnerd did not exit within 30000ms after runner.shutdown: ${error instanceof Error ? error.message : String(error)}`,
        true,
        evalLifecycleDiagnostics(core, handle, runnerStateDirectory),
      );
    }
    if (exited.code !== 0) {
      throw new DurableEvalInfrastructureError(
        "runner_exit_failure",
        `runnerd exited ${String(exited.code)}: ${exited.stderr}`,
        false,
        {
          ...evalLifecycleDiagnostics(core, handle, runnerStateDirectory),
          stderr: exited.stderr.slice(-16_384),
        },
      );
    }
    if (providerTerminalFailure !== null) {
      throw new DurableEvalInfrastructureError(
        providerTerminalFailure.failureClass,
        providerTerminalFailure.message,
        providerTerminalFailure.retryable,
        evalLifecycleDiagnostics(core, handle, runnerStateDirectory),
      );
    }
    const records = core.store.state.committedEvents.map(
      (committed) => committed.envelope.payload as Record<string, unknown>,
    );
    const evidence: Array<Record<string, unknown>> = [
      {
        id: "exposure-1",
        kind: "tool_exposure",
        at: new Date().toISOString(),
        turnId: null,
        data: {
          operationIds: exposedOperations.map(
            (operation) => operation.operationId,
          ),
        },
      },
    ];
    for (const data of discoveryEvidence) {
      evidence.push({
        id: `discovery-${evidence.length + 1}`,
        kind: "tool_discovery",
        at: new Date().toISOString(),
        turnId: identity.turnId,
        data,
      });
    }
    let evidenceIndex = 1;
    let assistantText = "";
    let semanticResult: Record<string, unknown> | null = null;
    let usage: Record<string, number> = {
      providerCalls: 1,
      providerRequests: providerKind === "claude_managed" ? 0 : 1,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      providerCostNanodollars: 0,
    };
    let providerSessionId: string | null = null;
    let providerPid: number | null = null;
    const providerProcessPids: number[] = [];
    const providerThreadIds: string[] = [];
    let sidecarPid: number | null = null;
    let agentPid: number | null = null;
    let providerDriver: string | null = null;
    let providerVersion: string | null = null;
    let agentServerVersion: string | null = null;
    let agentRuntimeVersion: string | null = null;
    let acpProtocolVersion: number | null = null;
    let acpxRecordId: string | null = null;
    let providerExecutionKind: string | null = null;
    let providerService: string | null = null;
    const projectedCalls = new Map<string, string>();
    for (const record of records) {
      const payload = record.payload as Record<string, unknown> | undefined;
      if (record.eventType === "harness.ready") {
        const descriptor = payload?.providerDescriptor as
          Record<string, unknown> | undefined;
        if (typeof descriptor?.providerSessionId === "string")
          providerSessionId = descriptor.providerSessionId;
        if (typeof descriptor?.processId === "number") {
          providerPid = descriptor.processId;
          providerProcessPids.push(descriptor.processId);
          if (descriptor.driver === "acpx_runtime")
            sidecarPid = descriptor.processId;
        }
        if (typeof descriptor?.driver === "string")
          providerDriver = descriptor.driver;
        if (typeof descriptor?.providerVersion === "string")
          providerVersion = descriptor.providerVersion;
        if (typeof descriptor?.agentServerVersion === "string")
          agentServerVersion = descriptor.agentServerVersion;
        if (typeof descriptor?.agentRuntimeVersion === "string")
          agentRuntimeVersion = descriptor.agentRuntimeVersion;
        if (typeof descriptor?.acpProtocolVersion === "number")
          acpProtocolVersion = descriptor.acpProtocolVersion;
        if (typeof descriptor?.agentProcessId === "number")
          agentPid = descriptor.agentProcessId;
        if (typeof descriptor?.acpxRecordId === "string")
          acpxRecordId = descriptor.acpxRecordId;
        if (typeof descriptor?.executionKind === "string")
          providerExecutionKind = descriptor.executionKind;
        if (typeof descriptor?.service === "string")
          providerService = descriptor.service;
        if (typeof payload?.threadId === "string")
          providerThreadIds.push(payload.threadId);
      }
      if (record.eventType === "harness.diagnostic") {
        if (
          payload?.providerMethod === "acpx/process" &&
          payload.role === "acp_agent" &&
          typeof payload.pid === "number"
        ) {
          agentPid = payload.pid;
        }
      }
      if (
        record.eventType === "run.result.proposed" &&
        payload &&
        semanticResult === null
      ) {
        semanticResult = structuredClone(payload);
      }
      const semantic = payload?.semantic_tool as
        Record<string, unknown> | undefined;
      if (semantic?.phase === "input" || semantic?.phase === "result") {
        const wrapperInput = semantic.input as
          Record<string, unknown> | undefined;
        const projectedOperationId =
          semantic.operationId === "invoke_discovered_capability"
            ? typeof wrapperInput?.operationId === "string"
              ? wrapperInput.operationId
              : (projectedCalls.get(String(semantic.callId)) ??
                semantic.operationId)
            : semantic.operationId;
        const projectedInput =
          semantic.operationId === "invoke_discovered_capability"
            ? wrapperInput?.input
            : semantic.input;
        if (semantic.phase === "input")
          projectedCalls.set(
            String(semantic.callId),
            String(projectedOperationId),
          );
        evidenceIndex += 1;
        evidence.push({
          id: `evidence-${evidenceIndex}`,
          kind: semantic.phase === "input" ? "tool_call" : "tool_result",
          at: new Date().toISOString(),
          turnId: identity.turnId,
          data:
            semantic.phase === "input"
              ? {
                  callId: semantic.callId,
                  operationId: projectedOperationId,
                  input: projectedInput,
                }
              : {
                  callId: semantic.callId,
                  operationId: projectedOperationId,
                  result: projectedSemanticResult(
                    semantic.operationId,
                    semantic.result,
                  ),
                },
        });
      }
      if (record.eventType === "provider.event") {
        const method = payload?.method;
        const params = payload?.params as Record<string, unknown> | undefined;
        if (
          typeof params?.delta === "string" &&
          String(method).includes("agentMessage")
        )
          assistantText += params.delta;
        const item = params?.item as Record<string, unknown> | undefined;
        // Codex reports the completed assistant item through `item/completed`; the
        // item type, rather than the notification method, identifies its role.
        if (
          !assistantText &&
          item?.type === "agentMessage" &&
          typeof item.text === "string"
        )
          assistantText = item.text;
        if (
          !assistantText &&
          String(method).includes("agentMessage") &&
          typeof params?.text === "string"
        )
          assistantText = params.text;
        if (
          method === "thread/tokenUsage/updated" &&
          typeof params?.tokenUsage === "object" &&
          params.tokenUsage
        ) {
          const tokenUsage = params.tokenUsage as Record<string, unknown>;
          const total =
            typeof tokenUsage.total === "object" && tokenUsage.total !== null
              ? (tokenUsage.total as Record<string, number>)
              : (tokenUsage as Record<string, number>);
          usage = {
            ...usage,
            inputTokens: total.inputTokens ?? 0,
            outputTokens: total.outputTokens ?? 0,
            cachedInputTokens: total.cachedInputTokens ?? 0,
            reasoningTokens: total.reasoningTokens ?? 0,
          };
        }
      }
      if (record.eventType === "item.delta") {
        const delta = payload?.delta;
        if (typeof delta === "string") assistantText += delta;
      }
      if (record.eventType === "item.completed") {
        const item = payload?.item as Record<string, unknown> | undefined;
        if (item?.type === "agentMessage" && typeof item.text === "string")
          assistantText = item.text;
      }
      if (record.eventType === "usage.reported") {
        const runDelta = payload?.runDelta as
          Record<string, number> | undefined;
        if (runDelta) {
          usage = {
            ...usage,
            providerRequests: Math.max(
              usage.providerRequests ?? 0,
              runDelta.requests ?? runDelta.providerRequests ?? 0,
            ),
            inputTokens: Math.max(
              usage.inputTokens ?? 0,
              runDelta.inputTokens ?? 0,
            ),
            outputTokens: Math.max(
              usage.outputTokens ?? 0,
              runDelta.outputTokens ?? 0,
            ),
            cachedInputTokens: Math.max(
              usage.cachedInputTokens ?? 0,
              runDelta.cacheReadTokens ?? 0,
            ),
            reasoningTokens: Math.max(
              usage.reasoningTokens ?? 0,
              runDelta.reasoningTokens ?? 0,
            ),
            providerCostNanodollars:
              typeof runDelta.providerCostUsd === "number"
                ? Math.max(
                    usage.providerCostNanodollars ?? 0,
                    Math.round(runDelta.providerCostUsd * 1_000_000_000),
                  )
                : usage.providerCostNanodollars,
          };
        }
      }
      if (record.eventType === "turn.completed") {
        const params = payload?.params as Record<string, unknown> | undefined;
        const turn = params?.turn as Record<string, unknown> | undefined;
        const items = Array.isArray(turn?.items) ? turn.items : [];
        const finalMessage = items.findLast((candidate) => {
          const item = candidate as Record<string, unknown>;
          return item.type === "agentMessage" && typeof item.text === "string";
        }) as Record<string, unknown> | undefined;
        if (typeof finalMessage?.text === "string")
          assistantText = finalMessage.text;
      }
    }
    for (const command of core.store.state.commands) {
      if (
        command.type !== "semantic_tool.result" ||
        command.status !== "completed"
      )
        continue;
      const payload = command.payload as Record<string, unknown>;
      const wrapperInput = payload.input as Record<string, unknown> | undefined;
      const projectedOperationId =
        payload.operationId === "invoke_discovered_capability"
          ? typeof wrapperInput?.operationId === "string"
            ? wrapperInput.operationId
            : (projectedCalls.get(String(payload.callId)) ??
              payload.operationId)
          : payload.operationId;
      if (
        evidence.some(
          (entry) =>
            entry.kind === "tool_result" &&
            (entry.data as Record<string, unknown>).callId === payload.callId,
        )
      )
        continue;
      evidenceIndex += 1;
      evidence.push({
        id: `evidence-${evidenceIndex}`,
        kind: "tool_result",
        at: new Date().toISOString(),
        turnId: identity.turnId,
        data: {
          callId: payload.callId,
          operationId: projectedOperationId,
          result: projectedSemanticResult(payload.operationId, payload.result),
        },
      });
    }
    if (!assistantText)
      assistantText = "Provider completed the requested Paperclip operation.";
    const finalState = JSON.stringify(authority.snapshot());
    const completedNativeResumeCall =
      nativeResumeCall as NativeResumeCall | null;
    const nativeResumeProof =
      input.nativeResume === undefined || completedNativeResumeCall === null
        ? undefined
        : (() => {
            const semanticEvents = records.flatMap((record) => {
              const payload = record.payload as
                Record<string, unknown> | undefined;
              const semantic = payload?.semantic_tool as
                Record<string, unknown> | undefined;
              return semantic?.callId === completedNativeResumeCall.callId &&
                semantic.operationId === completedNativeResumeCall.operationId
                ? [{ eventType: record.eventType, semantic }]
                : [];
            });
            const initialComments = JSON.parse(initialState) as {
              comments?: unknown[];
            };
            const finalComments = authority.snapshot().comments;
            return {
              schema: "paperclip.runner.native-resume-proof/v1",
              triggered: true,
              runnerRestarts,
              runnerProcessPids,
              providerProcessPids,
              sharedCodexServerPid: sharedCodexServer?.pid ?? null,
              sameProviderThread:
                providerThreadIds.length >= 2 &&
                new Set(providerThreadIds).size === 1,
              providerThreadDigest: providerThreadIds[0]
                ? `sha256:${createHash("sha256").update(providerThreadIds[0]).digest("hex")}`
                : null,
              callId: completedNativeResumeCall.callId,
              operationId: completedNativeResumeCall.operationId,
              inputEventCount: semanticEvents.filter(
                (event) => event.eventType === "semantic_tool.input",
              ).length,
              resultEventCount: semanticEvents.filter(
                (event) => event.eventType === "semantic_tool.result",
              ).length,
              semanticHandlerCallCount: nativeSemanticHandlerCallCount,
              controlPlaneEffectCount:
                finalComments.length - (initialComments.comments?.length ?? 0),
              runnerReconciledEventCount: semanticEvents.filter(
                (event) => event.eventType === "semantic_tool.reconciled",
              ).length,
              crashedRunnerSignal: crashedRunner?.signal ?? null,
              providerCalls: usage.providerCalls ?? 1,
              providerRequests: usage.providerRequests ?? 0,
              costNanodollars: usage.providerCostNanodollars ?? 0,
            };
          })();
    const now = new Date().toISOString();
    return {
      turn: { turnId: identity.turnId, status: "completed", assistantText },
      snapshot: {
        schema: "paperclip.capability.live-session.v1",
        revision: authority.snapshot().revision,
        sessionId: identity.normalizedSessionId,
        providerThreadId: "withheld",
        providerSessionId,
        providerModel: {
          id: input.model,
          provider:
            providerKind === "opencode"
              ? input.model.split("/", 1)[0]
              : providerKind === "claude_managed"
                ? "anthropic"
                : providerKind === "aws_agentcore"
                  ? "amazon-bedrock"
                  : providerKind === "acpx"
                    ? acpxProfile!.agent === "pi"
                      ? "openrouter"
                      : acpxProfile!.agent === "claude"
                        ? "anthropic"
                        : "openai"
                    : "openai",
        },
        modelHistory: [
          {
            requestedModel: input.model,
            effectiveModel: input.model,
            at: now,
            source: "provider_verified",
          },
        ],
        status: "idle",
        activeTurnId: null,
        semanticResult,
        ...(nativeResumeProof === undefined
          ? {}
          : { nativeResume: nativeResumeProof }),
        createdAt: now,
        updatedAt: now,
        authority: {
          active: true,
          runId: identity.runId,
          companyId,
          actorId: input.actorId,
          taskId: input.taskId,
          sessionId: identity.normalizedSessionId,
          scenarioId: input.attemptId,
          capabilities: input.capabilities,
          explicitClaims: input.explicitClaims,
        },
        config: {
          workingDirectory:
            providerKind === "claude_managed" ||
            providerKind === "aws_agentcore"
              ? null
              : tmpdir(),
          requestedModel: input.model,
          provider: providerKind,
          driver:
            providerKind === "opencode"
              ? "opencode_server"
              : providerKind === "claude_managed"
                ? "claude_managed_agents_api"
                : providerKind === "aws_agentcore"
                  ? "aws_agentcore_harness_api"
                  : providerKind === "acpx"
                    ? "acpx_runtime"
                    : "codex_app_server",
          providerVersion:
            providerKind === "opencode"
              ? (input.opencodeVersion ?? "1.18.17")
              : providerKind === "claude_managed"
                ? (input.managedProfile?.agentVersion ?? null)
                : providerKind === "aws_agentcore"
                  ? (input.agentCoreProfile?.harnessVersion ?? null)
                  : providerKind === "acpx"
                    ? acpxProfile!.acpxVersion
                    : null,
          ...(providerKind === "claude_managed"
            ? { managedProfile: input.managedProfile }
            : {}),
          ...(acpxProfile === null
            ? {}
            : { acpxAgent: acpxProfile.agent, acpxProfile }),
          scenario: { id: input.attemptId, claims: input.capabilities },
          capabilities: input.capabilities,
          explicitClaims: input.explicitClaims,
          seedState: initialState,
          turnTimeoutMs: input.turnTimeoutMs,
        },
        mockState: finalState,
        transcript: [
          {
            id: "transcript-user",
            role: "user",
            text: input.prompt,
            turnId: identity.turnId,
            at: now,
          },
          {
            id: "transcript-assistant",
            role: "assistant",
            text: assistantText,
            turnId: identity.turnId,
            at: now,
          },
        ],
        evidence,
        authorizationRecords: dispatcher.authorizationRecords(),
        process: {
          runnerPid: handle.child.pid ?? null,
          runnerProcessGroupId: handle.child.pid ?? null,
          providerPid,
          codexPid: providerKind === "codex" ? providerPid : null,
          sidecarPid,
          agentPid,
          providerDriver,
          providerVersion,
          acpxAgent: acpxProfile?.agent ?? null,
          agentServerVersion,
          agentRuntimeVersion,
          acpProtocolVersion,
          acpxRecordId,
          providerExecutionKind,
          providerService,
          runnerExited: true,
          runnerExitCode: exited.code,
          runnerSignal: exited.signal,
          childEnvironmentKeys: [],
          diagnostics: [],
        },
        networkEvidence: {
          realPaperclipRequests: 0,
          childPaperclipEnvironmentKeys: [],
        },
        terminalTurns: [
          {
            turnId: identity.turnId,
            status: "completed",
            reconciledByAttemptId: input.attemptId,
            observedAt: now,
          },
        ],
        usageLedger: [
          {
            receiptId: `usage-${input.attemptId}`,
            attemptId: input.attemptId,
            providerResponseId: providerSessionId,
            turnId: identity.turnId,
            providerCalls: usage.providerCalls ?? 1,
            providerRequests: usage.providerRequests ?? 0,
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
            cachedInputTokens: usage.cachedInputTokens ?? 0,
            reasoningTokens: usage.reasoningTokens ?? 0,
            costNanodollars: usage.providerCostNanodollars ?? 0,
            observedAt: now,
          },
        ],
      },
    };
  } finally {
    releaseNativeSemanticDispatch();
    handle.child.kill("SIGKILL");
    const sharedServer = sharedCodexServer;
    if (sharedServer !== null && sharedServer.exitCode === null) {
      sharedServer.kill("SIGTERM");
      await new Promise<void>((resolveExit) => {
        const timer = setTimeout(() => {
          sharedServer.kill("SIGKILL");
          resolveExit();
        }, 2_000);
        sharedServer.once("exit", () => {
          clearTimeout(timer);
          resolveExit();
        });
      });
    }
    await core.stop();
    await authority.stop();
    if (process.env.PAPERCLIP_KEEP_EVAL_STATE !== "1")
      rmSync(root, { recursive: true, force: true });
  }
}

export async function runDurableRecoveryRecovery(
  options: RunDurableRecoveryRecoveryOptions = {},
): Promise<DurableRecoveryRunTrace> {
  const fault = options.fault ?? "lost-ack";
  const identity = durableRecoveryIdentity();
  const scratchRoot =
    process.env.PAPERCLIP_RUN_SCRATCH_DIR ??
    process.env.PAPERCLIP_SCRATCH_DIR ??
    tmpdir();
  const root =
    options.stateDirectory ??
    mkdtempSync(
      resolve(scratchRoot, `paperclip-runner-durable-recovery-${fault}-`),
    );
  const runnerStateDirectory = resolve(root, "runner");
  const coreStateDirectory = resolve(root, "mock-core");
  mkdirSync(runnerStateDirectory, { recursive: true, mode: 0o700 });
  const core = new DurableRecoveryMockCore({
    stateDirectory: coreStateDirectory,
    identity,
    fault,
  });
  queueScenario(core, fault);
  await core.start();
  const tickets: string[] = [];
  let runnerRestarts = 0;
  const maxOutboxBytes = fault === "storage-pressure" ? 16 * 1024 : 64 * 1024;
  const p0ReserveBytes = fault === "storage-pressure" ? 8 * 1024 : 32 * 1024;

  const launch = (): RunnerProcessHandle => {
    const ticket = core.issueBootstrapTicket();
    tickets.push(ticket);
    return spawnRunner({
      connectUrl: core.connectUrl,
      stateDirectory: runnerStateDirectory,
      identity,
      ticket,
      maxOutboxBytes,
      p0ReserveBytes,
    });
  };

  let handle = launch();
  let result: RunnerProcessResult;
  try {
    if (fault === "runner-restart") {
      await core.waitForFaultTrigger();
      handle.child.kill("SIGKILL");
      await waitForProcess(handle);
      runnerRestarts += 1;
      handle = launch();
    } else if (fault === "lease-expiry") {
      const expired = await waitForProcess(handle);
      if (expired.code === 0) {
        throw new Error(
          "Lease-expiry injection did not produce a recoverable restart boundary.",
        );
      }
      runnerRestarts += 1;
      handle = launch();
    }
    result = await waitForProcess(handle);
    if (result.code !== 0) {
      throw new Error(
        `Durable recovery runner exited with code ${String(result.code)}: ${result.stderr.trim()}`,
      );
    }
    if (fault === "revoke") {
      // The runner can exit immediately after it sends the final rejection while
      // the mock core is still committing that HTTP request. Wait for the
      // durable command result before stopping the server and reading evidence.
      const deadline = Date.now() + 1_000;
      while (
        core.store.state.commands.find(
          (command) => command.commandId === "command_after_revoke",
        )?.status === "pending" &&
        Date.now() < deadline
      ) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
      }
    }
  } finally {
    await core.stop();
  }

  const runnerState = readRunnerState(runnerStateDirectory);
  const coreState = core.store.state;
  const runnerStatePath = resolve(runnerStateDirectory, "runner-state.json");
  const leaks = secretLeakCount(
    [runnerStatePath, core.store.path],
    [...tickets, "must-not-persist"],
  );
  const bootstrapTicketPersisted = persistedCapabilityShape(runnerStatePath, [
    "bootstrapTicket",
    "bootstrap_ticket",
  ]);
  const connectionLeaseTokenPersisted = persistedCapabilityShape(
    runnerStatePath,
    ["connectionLeaseToken", "connection_lease_token"],
  );
  const committedEvents = coreState.committedEvents.toSorted(
    (left, right) => left.sourceSeq - right.sourceSeq,
  );
  const p0Committed = committedEvents.filter(
    (event) => event.priority === 0,
  ).length;
  const completedCommands = coreState.commands.filter(
    (command) => command.status === "completed",
  );
  const rejectedCommands = coreState.commands.filter(
    (command) => command.status === "rejected",
  );
  const logicalEffects = coreState.commands.reduce(
    (sum, command) =>
      sum +
      (typeof command.result?.logicalEffectCount === "number"
        ? command.result.logicalEffectCount
        : 0),
    0,
  );
  const duplicateDeliveries = Object.values(
    coreState.commandDeliveryCounts,
  ).reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  const outcome: DurableRecoveryDiagnostics["recovery"]["outcome"] =
    fault === "drain"
      ? "drained"
      : fault === "revoke"
        ? "revoked"
        : runnerState.unrecoverableOutcome === null
          ? "recovered"
          : "unrecoverable";
  const diagnostics: DurableRecoveryDiagnostics = {
    schema: "paperclip.runner.durable.diagnostics.v1",
    fault,
    connection: {
      state: runnerState.lifecycle,
      connectionCount: coreState.connectionCount,
      reconnectCount: runnerState.reconnectCount,
      leaseId: coreState.lastLeaseId,
      leaseExpiresAt: coreState.lastLeaseExpiresAt,
    },
    identity,
    cursors: {
      runnerAckedSourceSeq: runnerState.ackedSourceSeq,
      runnerNextSourceSeq: runnerState.nextSourceSeq,
      coreAckedSourceSeq: coreState.ackedSourceSeq,
      highestCommittedSourceSeq: committedEvents.at(-1)?.sourceSeq ?? 0,
    },
    outbox: {
      events: runnerState.outbox.length,
      bytes: runnerState.outbox.reduce((sum, event) => sum + event.byteSize, 0),
      peakBytes: runnerState.peakOutboxBytes,
      maxBytes: maxOutboxBytes,
      backpressure: runnerState.backpressure,
      p0Committed,
      p0Lost:
        runnerState.ackedSourceSeq === coreState.ackedSourceSeq
          ? 0
          : p0Committed,
    },
    commands: {
      issued: coreState.commands.length,
      completed: completedCommands.length,
      rejected: rejectedCommands.length,
      logicalEffects,
      duplicateDeliveries,
    },
    recovery: {
      replayDeliveries: coreState.replayDeliveries,
      runnerRestarts,
      harnessRestarts: Math.max(0, runnerState.harnessGeneration - 1),
      malformedFrames: coreState.malformedFrames,
      freshBootstraps: coreState.freshBootstraps,
      outcome,
      reason:
        runnerState.unrecoverableOutcome ??
        runnerState.recoverableFailure ??
        `${fault.replaceAll("-", "_")}_completed`,
    },
    security: {
      bootstrapTicketPersisted,
      connectionLeaseTokenPersisted,
      secretLeakCount: leaks,
    },
    committedEvents,
  };
  const acceptedWithTooManyEffects = coreState.commands.some((command) => {
    const effectCount = command.result?.logicalEffectCount;
    return command.status === "completed" && effectCount !== 1;
  });
  const trace: DurableRecoveryRunTrace = {
    schema: "paperclip.runner.durable.trace.v1",
    diagnostics,
    runnerState,
    commands: structuredClone(coreState.commands),
    assertions: {
      stableIdentity:
        canonicalJson(identity) ===
        canonicalJson({
          runnerInstanceId: runnerState.runnerInstanceId,
          environmentLeaseId: runnerState.environmentLeaseId,
          runId: runnerState.runId,
          normalizedSessionId: runnerState.normalizedSessionId,
          turnId: runnerState.turnId,
          itemId: runnerState.itemId,
        }),
      sourceCursorContinuous:
        assertContinuous(committedEvents) &&
        runnerState.ackedSourceSeq === coreState.ackedSourceSeq,
      oneLogicalEffectPerAcceptedCommand: !acceptedWithTooManyEffects,
      noDuplicateLogicalEvents: committedEvents.every(
        (event) => event.logicalEffectCount === 1,
      ),
      p0Preserved: diagnostics.outbox.p0Lost === 0,
      boundedStorage:
        diagnostics.outbox.bytes <= maxOutboxBytes &&
        runnerState.peakOutboxBytes <= maxOutboxBytes,
      secretsRedacted:
        leaks === 0 &&
        !bootstrapTicketPersisted &&
        !connectionLeaseTokenPersisted,
    },
  };

  if (options.keepState !== true && options.stateDirectory === undefined) {
    rmSync(root, { recursive: true, force: true });
  }
  return trace;
}

export const durableRecoveryInternals = {
  runnerBinary,
  runnerEnvironment,
  credentialMaterial,
  tokenDigest,
  canonicalJson,
  durableRecoveryIdentity,
  projectedSemanticResult,
  claudeManagedEvalProviderConfiguration,
  managedProviderBudgetReached,
  durableEvalConnectionLeaseTtlMs,
};

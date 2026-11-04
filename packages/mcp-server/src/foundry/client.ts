import { randomBytes } from "node:crypto";
import { io, type Socket } from "socket.io-client";

// Foundry has no public server API. This speaks the same socket.io protocol as Foundry's
// own browser client: GET /join for a session cookie, POST /join to log in, then a socket
// bound to that cookie (v14 reads the session only from the cookie on the upgrade).
// Reference: https://github.com/thestranjer/foundry-vtt-mcp (MIT).

export type FoundryOptions = {
  /** Where Foundry listens, e.g. http://foundry:30000 */
  url: string;
  user: string;
  password: string;
};

export type Doc = Record<string, any>;
type Ack = { result?: Doc[]; error?: { message?: string } | string };

export function sessionFromSetCookie(headers: string[]): string | undefined {
  for (const header of headers) {
    const match = /(?:^|;\s*)session=([^;]+)/.exec(header);
    if (match) return match[1];
  }
}

export class FoundryClient {
  private socket?: Socket;
  // v14 rejects a POST whose Origin differs from the host it was sent to.
  private readonly origin: string;
  private connecting?: Promise<Socket>;

  constructor(
    private readonly opts: FoundryOptions,
    private readonly timeoutMs = 15_000,
  ) {
    this.origin = new URL(opts.url).origin;
  }

  /** Documents of one world collection, or of a compendium pack when `pack` is given. */
  async get(type: string, query: Record<string, unknown> = {}, pack?: string): Promise<Doc[]> {
    const ack = await this.modify(type, "get", { query, index: false, broadcast: false, ...(pack && { pack }) });
    return ack.result ?? [];
  }

  async modify(type: string, action: "get" | "create" | "update" | "delete", operation: Record<string, unknown>) {
    const ack = (await this.emit("modifyDocument", { type, action, operation })) as Ack;
    if (ack?.error) throw new Error(typeof ack.error === "string" ? ack.error : (ack.error.message ?? "Foundry error"));
    return ack;
  }

  /** The world payload Foundry sends its own client (users, packs, settings, ...). */
  world(): Promise<Doc> {
    return this.emit("world") as Promise<Doc>;
  }

  close() {
    this.socket?.disconnect();
    this.socket = undefined;
  }

  private async emit(event: string, ...args: unknown[]): Promise<unknown> {
    const socket = await this.ready();
    return socket.timeout(this.timeoutMs).emitWithAck(event, ...args);
  }

  private ready(): Promise<Socket> {
    if (this.socket?.connected) return Promise.resolve(this.socket);
    this.connecting ??= this.login().finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  private async login(): Promise<Socket> {
    this.close();
    const status = (await (await fetch(new URL("/api/status", this.opts.url))).json()) as { active?: boolean };
    if (!status.active) throw new Error("No Foundry world is running; launch one first");

    const join = await fetch(new URL("/join", this.opts.url), { headers: { Origin: this.origin }, redirect: "manual" });
    const session = sessionFromSetCookie(join.headers.getSetCookie()) ?? randomBytes(12).toString("hex");

    // Before login the socket is anonymous; it can still list users, as the join screen does.
    const anonymous = this.open(session);
    let userId: string | undefined;
    try {
      await this.bound(anonymous, false);
      const data = (await anonymous.timeout(this.timeoutMs).emitWithAck("getJoinData")) as { users?: Doc[] };
      userId = data.users?.find((u) => u.name === this.opts.user)?._id;
    } finally {
      anonymous.disconnect();
    }
    if (!userId) throw new Error(`Foundry user "${this.opts.user}" not found in this world`);

    const res = await fetch(new URL("/join", this.opts.url), {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `session=${session}`, Origin: this.origin },
      body: JSON.stringify({ userId, password: this.opts.password, action: "join" }),
      redirect: "manual",
    });
    const body = (await res.json().catch(() => ({}))) as { status?: string; error?: string; message?: string };
    if (!res.ok || body.status !== "success") {
      throw new Error(`Foundry login failed (${res.status}): ${body.error ?? body.message ?? "unknown"}`);
    }

    const socket = this.open(session);
    await this.bound(socket, true);
    socket.on("disconnect", () => {
      if (this.socket === socket) this.socket = undefined;
    });
    this.socket = socket;
    return socket;
  }

  private open(session: string): Socket {
    return io(this.opts.url, {
      transports: ["websocket"],
      extraHeaders: { Cookie: `session=${session}`, Origin: this.origin },
      reconnection: false,
      timeout: this.timeoutMs,
    });
  }

  /** Foundry emits `session` once per connection: a user id when logged in, null when anonymous. */
  private bound(socket: Socket, needUser: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error("Timed out waiting for the Foundry session")), this.timeoutMs);
      const fail = (error: Error) => {
        clearTimeout(timer);
        socket.disconnect();
        reject(error);
      };
      socket.once("connect_error", fail);
      socket.once("session", (payload: { userId?: string } | null) => {
        clearTimeout(timer);
        if (needUser && !payload?.userId) fail(new Error("Foundry did not bind the session to a user"));
        else resolve();
      });
    });
  }
}

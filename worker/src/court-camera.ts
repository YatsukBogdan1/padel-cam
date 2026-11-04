import { DurableObject } from 'cloudflare:workers';
import {
  renewClaims,
  setCourtHealth,
  setCourtPresence,
  setCourtVersion,
  touchCourt,
  updateRecording,
} from './db';
import { endOverdueMatches } from './matches';
import { resumePlanFor } from './resume';
import type { CameraMessage, Env } from './types';

/** How long `/command` waits for the agent to confirm it received a command. */
const ACK_TIMEOUT_MS = 6_000;

/**
 * One instance per court. Holds the camera's WebSocket using the hibernation
 * API (no duration billing while idle-connected) and relays start/stop commands
 * from the API down to the Pi. Also tracks the court's online state in D1.
 */
export class CourtCamera extends DurableObject<Env> {
  /**
   * Commands sent but not yet acknowledged, keyed by commandId. In-memory is
   * safe despite hibernation: the DO cannot be evicted while the `/command`
   * fetch that owns the entry is still in flight, and every entry is settled or
   * timed out before that fetch returns.
   */
  private pendingAcks = new Map<string, (ack: { ok: boolean; error?: string }) => void>();

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Internal: API asks us to push a command to the connected camera.
    if (url.pathname === '/command') {
      return this.relayCommand(await req.text());
    }

    // Internal: a match started; wake when it is due to end. One alarm per court
    // is enough because one court records one match at a time.
    if (url.pathname === '/alarm') {
      const { courtId, at } = (await req.json()) as { courtId: string; at: number };
      await this.ctx.storage.put('courtId', courtId);
      await this.ctx.storage.setAlarm(at);
      return new Response('ok');
    }

    // Camera opening its persistent connection.
    if (req.headers.get('Upgrade') === 'websocket') {
      const courtId = url.searchParams.get('courtId') ?? 'unknown';
      await this.ctx.storage.put('courtId', courtId);

      // One court is one camera. Without this, a reconnect that arrives while
      // the old socket is still held leaves two live agents attached: /command
      // broadcasts to both, both open a capture session for the same
      // recordingId, and both upload part N of the same multipart upload --
      // each overwriting the other's etag. `complete` then fails with "one or
      // more of the specified parts could not be found" and the row hangs in
      // `uploading` forever. Retire the older connection instead.
      for (const stale of this.ctx.getWebSockets()) {
        try {
          stale.close(1012, 'replaced by a newer connection');
        } catch {
          // already gone
        }
      }

      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server); // hibernatable
      await setCourtPresence(this.env, courtId, true, Date.now());

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('not found', { status: 404 });
  }

  /**
   * Send a command and wait for the agent to confirm it. A socket the venue's
   * NAT quietly dropped still accepts `send()` without error, so the old check
   * -- "at least one socket is attached" -- reported success for commands that
   * reached nobody, and the operator got a recording light for a camera that
   * was never told to record.
   */
  private async relayCommand(body: string): Promise<Response> {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) {
      return new Response('no camera connected', { status: 409 });
    }

    const { commandId } = JSON.parse(body) as { commandId?: string };
    if (!commandId) {
      // Unacknowledged fire-and-forget: keeps older agents working.
      if (deliver(sockets, body) === 0) {
        return new Response('no camera connected', { status: 409 });
      }
      return new Response('ok');
    }

    const acked = new Promise<{ ok: boolean; error?: string } | null>((resolve) => {
      this.pendingAcks.set(commandId, resolve);
      setTimeout(() => {
        if (this.pendingAcks.delete(commandId)) resolve(null);
      }, ACK_TIMEOUT_MS);
    });

    // `getWebSockets()` can hand back a socket that is already closed -- one
    // retired by a reconnect, or dropped by the network -- and `send()` on it
    // throws. Unguarded, that surfaced to the operator as a 500 "Can't call
    // WebSocket send() after close()" instead of the honest "no camera
    // connected", and filed an incident for what is a routine reconnect.
    if (deliver(sockets, body) === 0) {
      await this.markOfflineIfLast();
      return new Response('no camera connected', { status: 409 });
    }
    const ack = await acked;

    if (ack === null) {
      // Nothing answered. The socket is a corpse; drop it so presence and the
      // next command both reflect reality instead of retrying into the void.
      for (const ws of sockets) {
        try {
          ws.close(1001, 'unacknowledged');
        } catch {
          // already gone
        }
      }
      await this.markOfflineIfLast();
      return new Response('camera did not acknowledge', { status: 409 });
    }
    if (!ack.ok) {
      return new Response(ack.error ?? 'camera rejected the command', { status: 409 });
    }
    return new Response('ok');
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    let msg: CameraMessage;
    try {
      msg = JSON.parse(message) as CameraMessage;
    } catch {
      return;
    }

    const courtId = await this.courtId();

    switch (msg.type) {
      case 'status':
        await updateRecording(this.env, msg.recordingId, msg.patch);
        break;

      case 'heartbeat': {
        // Advancing last_seen is the entire liveness signal: presence is derived
        // from this timestamp, so a Pi that stops beating expires on its own.
        const now = Date.now();
        await touchCourt(this.env, courtId, now);
        // Renewing the lease is what lets the camera hold unsent footage without
        // the stale sweep aborting the upload underneath it.
        if (msg.claims?.length) await renewClaims(this.env, msg.claims, now);
        if (msg.health) await setCourtHealth(this.env, courtId, msg.health);
        ws.send(JSON.stringify({ type: 'heartbeat-ack' }));
        break;
      }

      case 'hello': {
        await setCourtVersion(this.env, courtId, msg.version);
        await touchCourt(this.env, courtId, Date.now());
        // A camera that came back with footage on disk asks what to do with it.
        // The answer has to come from here: the Pi cannot know whether the
        // operator ended the match while it was rebooting.
        if (msg.resume?.length) {
          const plan = await resumePlanFor(this.env, courtId, msg.resume);
          ws.send(JSON.stringify({ type: 'resume-plan', items: plan }));
        }
        break;
      }

      case 'ack': {
        const resolve = this.pendingAcks.get(msg.commandId);
        if (resolve) {
          this.pendingAcks.delete(msg.commandId);
          resolve({ ok: msg.ok, error: msg.error });
        }
        break;
      }
    }
  }

  /**
   * Auto-stop. Acts on whatever is overdue rather than on the match that set the
   * alarm, so a stale or early wake-up is harmless and nothing needs cancelling
   * when a match is stopped by hand. If the camera is offline right now, the stop
   * is still stamped on the row, and the Pi reads it when it returns.
   */
  async alarm(): Promise<void> {
    // Relay directly: going through our own stub would wait on ourselves.
    await endOverdueMatches(this.env, await this.courtId(), (body) => this.relayCommand(body));
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    // An abnormal drop arrives as 1006, which close() refuses to send. The throw
    // used to skip markOfflineIfLast below, so the court kept reading online.
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch {
      // already closed
    }
    await this.markOfflineIfLast();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011);
    } catch {
      // already closed
    }
    await this.markOfflineIfLast();
  }

  private async courtId(): Promise<string> {
    return (await this.ctx.storage.get<string>('courtId')) ?? 'unknown';
  }

  private async markOfflineIfLast(): Promise<void> {
    if (this.ctx.getWebSockets().length > 0) return;
    await setCourtPresence(this.env, await this.courtId(), false, Date.now());
  }
}

/**
 * Push a command to every attached socket, skipping any that are already closed,
 * and report how many actually took it.
 *
 * `ctx.getWebSockets()` can return a socket that has since been closed -- retired
 * by a reconnect, or dropped by the network -- and `send()` on one of those
 * throws. That escaped as a 500 to the operator ("Can't call WebSocket send()
 * after close()") in place of the truthful 409, and filed a production incident
 * for what is an ordinary reconnect.
 */
function deliver(sockets: WebSocket[], body: string): number {
  let delivered = 0;
  for (const ws of sockets) {
    try {
      ws.send(body);
      delivered++;
    } catch {
      // Already closed; it was never going to receive this.
    }
  }
  return delivered;
}

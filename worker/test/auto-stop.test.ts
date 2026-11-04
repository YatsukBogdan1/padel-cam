// A match ends on its own. The three ways that can happen -- the court's alarm,
// the five-minute cron when an alarm is lost, and a camera returning from a power
// cut after the end time -- must all stop the camera rather than film the next
// group.

import {
  createExecutionContext,
  createScheduledController,
  env,
  runDurableObjectAlarm,
  runInDurableObject,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import type { CourtCamera } from '../src/court-camera';
import worker from '../src/index';
import { resumePlanFor } from '../src/resume';
import {
  getMatchByToken,
  seedCourt,
  segmentsOf,
  startFromCourt,
  type FakeCamera,
} from './helpers';

let camera: FakeCamera | null = null;
afterEach(() => {
  camera?.close();
  camera = null;
});

/** A live match whose end time has already passed. */
async function overdueMatch() {
  const seeded = await seedCourt();
  camera = seeded.camera;
  const started = await startFromCourt(seeded.qrToken);
  const match = (await getMatchByToken(started.token!))!;
  await env.DB.prepare(`UPDATE matches SET ends_at = ? WHERE session_id = ?`)
    .bind(Date.now() - 1_000, match.session_id)
    .run();
  const [rec] = await segmentsOf(match.session_id);
  return { ...seeded, match, recording: rec! };
}

describe('auto-stop', () => {
  it('the court alarm stops an overdue match -- and the camera actually hears it', async () => {
    const { courtId, recording } = await overdueMatch();
    const stub = env.COURT_CAMERA.get(env.COURT_CAMERA.idFromName(courtId));

    // The regression this guards: the alarm used to relay through the DO's own
    // stub. In production that waits on itself -- the agent's ack can never be
    // delivered, the command times out and the socket is torn down, so the row
    // reads stopped while the camera never hears it. This runtime does not
    // reproduce the hang, so assert the mechanism: during the alarm, nothing
    // may come back in through the DO's own /command.
    type Spied = CourtCamera & { selfCalls?: string[] };
    await runInDurableObject(stub, (instance: Spied) => {
      instance.selfCalls = [];
      const original = instance.fetch.bind(instance);
      instance.fetch = (req: Request) => {
        instance.selfCalls!.push(new URL(req.url).pathname);
        return original(req);
      };
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const calls = await runInDurableObject(stub, (instance: Spied) => instance.selfCalls);
    // The spy must have survived to the alarm, or this assertion proves nothing.
    expect(calls).toBeDefined();
    expect(calls).not.toContain('/command');
    expect(camera!.received('stop').map((c) => c.recordingId)).toEqual([recording.id]);
    const [after] = await segmentsOf(recording.session_id!);
    expect(after!.status).toBe('uploading');
    expect(after!.stop_requested_at).not.toBeNull();
  });

  it('the alarm leaves a match that is not yet due alone', async () => {
    const seeded = await seedCourt();
    camera = seeded.camera;
    const started = await startFromCourt(seeded.qrToken);
    const match = (await getMatchByToken(started.token!))!;
    const stub = env.COURT_CAMERA.get(env.COURT_CAMERA.idFromName(seeded.courtId));

    await runDurableObjectAlarm(stub);

    expect(camera!.received('stop')).toHaveLength(0);
    const [rec] = await segmentsOf(match.session_id);
    expect(rec!.status).toBe('recording');
  });

  it('the five-minute cron stops an overdue match whose alarm was lost', async () => {
    const { recording } = await overdueMatch();

    const ctx = createExecutionContext();
    await worker.scheduled(
      createScheduledController({ scheduledTime: Date.now(), cron: '*/5 * * * *' }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(camera!.received('stop').map((c) => c.recordingId)).toEqual([recording.id]);
    const [after] = await segmentsOf(recording.session_id!);
    expect(after!.status).toBe('uploading');
  });

  it('stamps the stop even when the camera is offline at the end time', async () => {
    const { courtId, recording } = await overdueMatch();
    camera!.close();
    camera = null;
    const stub = env.COURT_CAMERA.get(env.COURT_CAMERA.idFromName(courtId));

    await runDurableObjectAlarm(stub);

    // Nobody heard it -- but the Pi reads this when it comes back, and stops.
    const [after] = await segmentsOf(recording.session_id!);
    expect(after!.stop_requested_at).not.toBeNull();
  });
});

describe('a camera returning from a power cut', () => {
  const report = (recordingId: string, sessionId: string) => [
    {
      localId: 'local-1',
      recordingId,
      sessionId,
      segment: 1,
      sealed: true,
      pendingParts: 0,
      capturing: false,
    },
  ];

  it('resumes a match that is still within its booking', async () => {
    const seeded = await seedCourt();
    camera = seeded.camera;
    const started = await startFromCourt(seeded.qrToken);
    const match = (await getMatchByToken(started.token!))!;
    const [rec] = await segmentsOf(match.session_id);

    const plan = await resumePlanFor(env, seeded.courtId, report(rec!.id, match.session_id));
    expect(plan.at(-1)?.continueSession).toBe(match.session_id);
  });

  it('does not resume a match past its end, even before auto-stop has stamped it', async () => {
    const { courtId, match, recording } = await overdueMatch();
    // Not stopped yet: the gap between the end time and the alarm or cron.
    expect(recording.stop_requested_at).toBeNull();

    const plan = await resumePlanFor(env, courtId, report(recording.id, match.session_id));
    expect(plan.some((d) => d.continueSession)).toBe(false);
  });
});

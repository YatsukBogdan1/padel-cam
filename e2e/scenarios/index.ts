// Order matters: preflight first, so a broken camera fails once and clearly
// rather than as five confusing downstream failures. Destructive scenarios come
// after the happy path has proved the basics.

import { preflight } from './00-preflight';
import { happyPath } from './10-happy-path';
import { networkLoss } from './20-network-loss';
import { agentCrash } from './30-agent-crash';
import { stopWhileDown } from './40-stop-while-down';
import { multipartIntegrity } from './45-multipart-integrity';
import { diskBudget } from './50-disk-budget';
import { cameraContention, presence } from './60-camera-and-presence';
import { qrMatch } from './70-qr-match';
import { qrAutoStop } from './75-qr-auto-stop';
import { qrFreePeriod } from './78-qr-free-period';
import { hardReboot } from './90-hard-reboot';
import type { Scenario } from '../lib/harness';

export const scenarios: Scenario[] = [
  preflight,
  happyPath,
  networkLoss,
  agentCrash,
  stopWhileDown,
  multipartIntegrity,
  diskBudget,
  cameraContention,
  presence,
  qrMatch,
  qrAutoStop,
  qrFreePeriod,
  hardReboot,
];

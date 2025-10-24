import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { TypedEnvelope, IcsReferralAck, IcsReferralRequest } from '@onecare/events';

interface CpcsServiceRequest {
  id: string;
  patientReference: string;
  presentingComplaintCode: string;
  consentTimestamp: string;
  metadata?: Record<string, unknown> | null;
}

interface ReferralResult {
  status: string;
  reference?: string;
  reason?: string;
}

const FIXTURE_DIR = join(__dirname, 'fixtures');

type FixtureName =
  | 'cpcs-referral-success'
  | 'cpcs-referral-error'
  | 'ics-referral-request'
  | 'ics-referral-ack';

type FixtureIndex = Partial<Record<FixtureName, string>>;

const JSON_EXT = '.json';

function resolveFixturePath(name: FixtureName): string {
  return join(FIXTURE_DIR, `${name}${JSON_EXT}`);
}

function loadJsonFixture<T>(name: FixtureName): T {
  const path = resolveFixturePath(name);
  const buffer = readFileSync(path, 'utf8');
  return JSON.parse(buffer) as T;
}

export interface CpcsSandboxScenario {
  organisationId: string;
  serviceRequest: CpcsServiceRequest;
  summary: string;
  expected: ReferralResult;
}

export interface IcsSandboxRequest {
  envelope: TypedEnvelope<IcsReferralRequest>;
}

export interface IcsSandboxAck {
  ack: IcsReferralAck;
}

export interface SandboxHarness {
  list(): FixtureName[];
  cpcsSuccess(): CpcsSandboxScenario;
  cpcsError(): CpcsSandboxScenario;
  icsRequest(): IcsSandboxRequest;
  icsAck(): IcsSandboxAck;
}

export function createSandboxHarness(): SandboxHarness {
  const available = buildFixtureIndex();
  return {
    list: () => Object.keys(available) as FixtureName[],
    cpcsSuccess: () => loadJsonFixture<CpcsSandboxScenario>('cpcs-referral-success'),
    cpcsError: () => loadJsonFixture<CpcsSandboxScenario>('cpcs-referral-error'),
    icsRequest: () => loadJsonFixture<IcsSandboxRequest>('ics-referral-request'),
    icsAck: () => loadJsonFixture<IcsSandboxAck>('ics-referral-ack'),
  };
}

function buildFixtureIndex(): FixtureIndex {
  const files = readdirSync(FIXTURE_DIR);
  return files.reduce<FixtureIndex>((acc, file) => {
    if (!file.endsWith(JSON_EXT)) return acc;
    const name = file.slice(0, -JSON_EXT.length) as FixtureName;
    acc[name] = file;
    return acc;
  }, {});
}

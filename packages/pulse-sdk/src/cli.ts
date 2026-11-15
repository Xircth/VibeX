import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { PulseClient, type PulseTransport } from './client.ts';
import { generateUlid } from './defineEvent.ts';
import { evaluatePulseRuleLocally } from './evaluator.ts';
import type {
  EventEnvelope,
  PulseDryRunReport,
  PulseRuleSpec,
} from './types.ts';

export interface CliIo {
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  transport?: PulseTransport;
}

export interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  data?: unknown;
}

function parseFlags(argv: string[]): {
  subcommand: string | undefined;
  flags: Map<string, string>;
  booleans: Set<string>;
} {
  const [subcommand, ...rest] = argv;
  const flags = new Map<string, string>();
  const booleans = new Set<string>();

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) continue;
    const eqIdx = token.indexOf('=');
    if (eqIdx > 2) {
      flags.set(token.slice(2, eqIdx), token.slice(eqIdx + 1));
      continue;
    }
    const key = token.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(key, next);
      i += 1;
    } else {
      booleans.add(key);
    }
  }

  return { subcommand, flags, booleans };
}

function renderUsage(): string {
  return [
    'Usage:',
    '  vibex-pulse emit --type <eventType> [--thread <threadKey>] --data <json> [--url <baseUrl>] [--token <bearer>] [--secret <whsec_...>] [--offline]',
    '  vibex-pulse dry-run --rule <rule.json> --event <event.json> [--url <baseUrl>] [--token <bearer>]',
  ].join('\n');
}

export async function runCli(
  argv: string[],
  io: CliIo = {}
): Promise<CliRunResult> {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const writeOut = (line: string) => {
    outLines.push(line);
    io.stdout?.(line);
  };
  const writeErr = (line: string) => {
    errLines.push(line);
    io.stderr?.(line);
  };

  const { subcommand, flags, booleans } = parseFlags(argv);

  if (!subcommand || booleans.has('help') || subcommand === '--help') {
    const usage = renderUsage();
    writeOut(usage);
    return {
      exitCode: subcommand ? 0 : 2,
      stdout: outLines.join('\n'),
      stderr: errLines.join('\n'),
    };
  }

  try {
    if (subcommand === 'emit') {
      const eventType = flags.get('type')?.trim();
      const rawData = flags.get('data') ?? flags.get('json') ?? '{}';
      const threadKey = flags.get('thread') ?? null;

      if (!eventType) {
        writeErr('Error: --type <eventType> is required for `vibex-pulse emit`.');
        return {
          exitCode: 2,
          stdout: outLines.join('\n'),
          stderr: errLines.join('\n'),
        };
      }

      let payload: unknown;
      try {
        payload = JSON.parse(rawData);
      } catch (err) {
        writeErr(
          `Error: --data is not valid JSON (${
            err instanceof Error ? err.message : String(err)
          }).`
        );
        return {
          exitCode: 2,
          stdout: outLines.join('\n'),
          stderr: errLines.join('\n'),
        };
      }

      const explicitUrl =
        flags.get('url') ??
        process.env.VIBEX_PULSE_URL ??
        process.env.VIBEX_SERVER_URL;

      if (booleans.has('offline') || (!explicitUrl && !io.transport)) {
        const eventId = generateUlid();
        const deliveryId = flags.get('delivery-id') ?? `dlv_${eventId}`;
        const envelope: EventEnvelope = {
          eventId,
          deliveryId,
          source: {
            kind: 'sdk_custom',
            instanceId: flags.get('source') ?? 'vibex-pulse-cli',
            trustLevel: 'trusted_internal',
          },
          eventType,
          occurredAt: new Date().toISOString(),
          actor: {
            id: flags.get('actor') ?? 'vibex-pulse-cli',
            displayName: null,
            roles: [],
            isBot: false,
            isSelf: false,
          },
          threadKey,
          correlations: [],
          replyChannels: [],
          trace: {
            rootEventId: eventId,
            parentRunId: null,
            hopCount: Number(flags.get('hop-count') ?? 0),
          },
          payload,
        };
        writeOut(JSON.stringify(envelope, null, 2));
        return {
          exitCode: 0,
          stdout: outLines.join('\n'),
          stderr: errLines.join('\n'),
          data: envelope,
        };
      }

      const client = new PulseClient({
        baseUrl: explicitUrl,
        bearerToken: flags.get('token'),
        hmacSecret: flags.get('secret'),
        transport: io.transport,
      });

      const emitted = await client.emit({
        eventType,
        threadKey,
        deliveryId: flags.get('delivery-id'),
        payload,
      });

      writeOut(JSON.stringify(emitted, null, 2));
      return {
        exitCode: 0,
        stdout: outLines.join('\n'),
        stderr: errLines.join('\n'),
        data: emitted,
      };
    }

    if (subcommand === 'dry-run') {
      const rulePath = flags.get('rule');
      const eventPath = flags.get('event');

      if (!rulePath || !eventPath) {
        writeErr(
          'Error: --rule <file> and --event <file> are required for `vibex-pulse dry-run`.'
        );
        return {
          exitCode: 2,
          stdout: outLines.join('\n'),
          stderr: errLines.join('\n'),
        };
      }

      const [ruleRaw, eventRaw] = await Promise.all([
        readFile(rulePath, 'utf8'),
        readFile(eventPath, 'utf8'),
      ]);

      const parsedRule = JSON.parse(ruleRaw) as
        | PulseRuleSpec
        | { spec: PulseRuleSpec };
      const spec: PulseRuleSpec =
        'spec' in parsedRule &&
        typeof parsedRule.spec === 'object' &&
        parsedRule.spec !== null
          ? parsedRule.spec
          : (parsedRule as PulseRuleSpec);
      const envelope = JSON.parse(eventRaw) as EventEnvelope;

      let report: PulseDryRunReport;
      if (flags.get('url') || io.transport) {
        const client = new PulseClient({
          baseUrl: flags.get('url'),
          bearerToken: flags.get('token'),
          transport: io.transport,
        });
        report = await client.dryRunRule(spec, envelope);
      } else {
        report = evaluatePulseRuleLocally(spec, envelope);
      }

      writeOut(JSON.stringify(report, null, 2));
      const ok = booleans.has('validate-only')
        ? report.valid
        : report.valid && report.matched;
      return {
        exitCode: ok ? 0 : 1,
        stdout: outLines.join('\n'),
        stderr: errLines.join('\n'),
        data: report,
      };
    }

    writeErr(`Unknown command: ${subcommand}\n${renderUsage()}`);
    return {
      exitCode: 2,
      stdout: outLines.join('\n'),
      stderr: errLines.join('\n'),
    };
  } catch (err) {
    writeErr(err instanceof Error ? err.message : String(err));
    return {
      exitCode: 1,
      stdout: outLines.join('\n'),
      stderr: errLines.join('\n'),
    };
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const result = await runCli(argv, {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  });
  process.exitCode = result.exitCode;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}

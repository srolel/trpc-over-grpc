import { inspect } from 'node:util';
import {
  createBenchmarkClients,
  createBenchmarkInput,
  startBenchmarkServers,
  type BenchmarkClients,
  type BenchmarkInput,
} from './shared.js';

type TransportName = 'httpLink' | 'grpcLink';

type Scenario = {
  name: string;
  input: BenchmarkInput;
  iterations: number;
  concurrency: number;
};

type BenchmarkSummary = {
  transport: TransportName;
  iterations: number;
  concurrency: number;
  totalMs: number;
  requestsPerSecond: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  minMs: number;
  maxMs: number;
};

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected ${name} to be a positive number, received ${inspect(raw)}`);
  }

  return Math.floor(parsed);
}

const config = {
  warmup: readIntEnv('BENCH_WARMUP', 200),
  iterations: readIntEnv('BENCH_ITERATIONS', 2_000),
  concurrency: readIntEnv('BENCH_CONCURRENCY', 64),
};

function nowNs(): bigint {
  return process.hrtime.bigint();
}

function nsToMs(durationNs: bigint): number {
  return Number(durationNs) / 1_000_000;
}

function percentile(sortedValues: number[], value: number): number {
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * value) - 1),
  );
  return sortedValues[index] ?? 0;
}

function summarize(
  transport: TransportName,
  iterations: number,
  concurrency: number,
  durationsMs: number[],
  totalMs: number,
): BenchmarkSummary {
  const sorted = [...durationsMs].sort((left, right) => left - right);
  const sum = durationsMs.reduce((accumulator, current) => accumulator + current, 0);

  return {
    transport,
    iterations,
    concurrency,
    totalMs,
    requestsPerSecond: (iterations / totalMs) * 1_000,
    avgMs: sum / durationsMs.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    minMs: sorted[0] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
  };
}

async function invokeTransport(
  clients: BenchmarkClients,
  transport: TransportName,
  input: BenchmarkInput,
  requestId: string,
) {
  if (transport === 'grpcLink') {
    return await clients.grpcClient.payloadRoundtrip.query(input, {
      context: {
        requestId,
      },
    });
  }

  return await clients.httpClient.payloadRoundtrip.query(input, {
    context: {
      requestId,
    },
  });
}

async function warmupTransport(
  clients: BenchmarkClients,
  transport: TransportName,
  input: BenchmarkInput,
  warmupCount: number,
) {
  for (let index = 0; index < warmupCount; index += 1) {
    await invokeTransport(clients, transport, input, `warmup-${transport}-${index}`);
  }
}

async function runScenario(
  clients: BenchmarkClients,
  transport: TransportName,
  scenario: Scenario,
): Promise<BenchmarkSummary> {
  const durationsMs = new Array<number>(scenario.iterations);
  let nextIndex = 0;
  const startedAt = nowNs();

  const workers = Array.from(
    { length: Math.min(scenario.concurrency, scenario.iterations) },
    async () => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;

        if (currentIndex >= scenario.iterations) {
          return;
        }

        const requestStartedAt = nowNs();
        await invokeTransport(
          clients,
          transport,
          scenario.input,
          `${transport}-${scenario.name}-${currentIndex}`,
        );
        durationsMs[currentIndex] = nsToMs(nowNs() - requestStartedAt);
      }
    },
  );

  await Promise.all(workers);

  return summarize(
    transport,
    scenario.iterations,
    scenario.concurrency,
    durationsMs,
    nsToMs(nowNs() - startedAt),
  );
}

function formatNumber(value: number, fractionDigits = 2): string {
  return value.toFixed(fractionDigits);
}

function printSummary(summary: BenchmarkSummary) {
  console.log(
    [
      summary.transport.padEnd(8),
      `total=${formatNumber(summary.totalMs)}ms`.padStart(16),
      `rps=${formatNumber(summary.requestsPerSecond)}`.padStart(16),
      `avg=${formatNumber(summary.avgMs)}ms`.padStart(14),
      `p50=${formatNumber(summary.p50Ms)}ms`.padStart(14),
      `p95=${formatNumber(summary.p95Ms)}ms`.padStart(14),
      `p99=${formatNumber(summary.p99Ms)}ms`.padStart(14),
    ].join(' '),
  );
}

function printComparison(http: BenchmarkSummary, grpc: BenchmarkSummary) {
  const throughputDelta = ((grpc.requestsPerSecond / http.requestsPerSecond) - 1) * 100;
  const avgLatencyDelta = ((grpc.avgMs / http.avgMs) - 1) * 100;

  console.log(
    `Δ grpc vs http: throughput ${formatNumber(throughputDelta)}%, avg latency ${formatNumber(avgLatencyDelta)}%`,
  );
}

async function main() {
  console.log('Benchmark config');
  console.log(
    JSON.stringify(
      {
        warmupPerTransport: config.warmup,
        iterationsPerScenario: config.iterations,
        concurrentRequests: config.concurrency,
        note: 'Compares grpcLink against standard tRPC httpLink on the same router and resolver.',
      },
      null,
      2,
    ),
  );

  const servers = await startBenchmarkServers();
  const clients = createBenchmarkClients(servers);

  try {
    const sanityInput = createBenchmarkInput('tiny');
    const sanityRequestId = 'sanity-check';
    const httpResult = await invokeTransport(
      clients,
      'httpLink',
      sanityInput,
      sanityRequestId,
    );
    const grpcResult = await invokeTransport(
      clients,
      'grpcLink',
      sanityInput,
      sanityRequestId,
    );

    if (JSON.stringify(httpResult) !== JSON.stringify(grpcResult)) {
      throw new Error('Sanity check failed: HTTP and gRPC responses differ');
    }

    const scenarios: Scenario[] = [
      {
        name: 'tiny-sequential',
        input: createBenchmarkInput('tiny'),
        iterations: config.iterations,
        concurrency: 1,
      },
      {
        name: 'tiny-concurrent',
        input: createBenchmarkInput('tiny'),
        iterations: config.iterations,
        concurrency: config.concurrency,
      },
      {
        name: 'medium-sequential',
        input: createBenchmarkInput('medium'),
        iterations: config.iterations,
        concurrency: 1,
      },
      {
        name: 'medium-concurrent',
        input: createBenchmarkInput('medium'),
        iterations: config.iterations,
        concurrency: config.concurrency,
      },
    ];

    for (const scenario of scenarios) {
      console.log(`\nScenario: ${scenario.name}`);
      await warmupTransport(clients, 'httpLink', scenario.input, config.warmup);
      await warmupTransport(clients, 'grpcLink', scenario.input, config.warmup);

      const httpSummary = await runScenario(clients, 'httpLink', scenario);
      const grpcSummary = await runScenario(clients, 'grpcLink', scenario);

      printSummary(httpSummary);
      printSummary(grpcSummary);
      printComparison(httpSummary, grpcSummary);
    }
  } finally {
    clients.close();
    await servers.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

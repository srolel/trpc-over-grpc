import * as grpc from '@grpc/grpc-js';
import { createTRPCClient, httpLink } from '@trpc/client';
import { initTRPC } from '@trpc/server';
import { createHTTPServer } from '@trpc/server/adapters/standalone';
import superjson from 'superjson';
import { z } from 'zod';
import { addTRPCToGRPCServer, grpcLink } from '../../src/index.js';

export interface BenchmarkContext {
  requestId: string | null;
  callerService: string | null;
}

const t = initTRPC.context<BenchmarkContext>().create({
  transformer: superjson,
});

const benchInputSchema = z.object({
  id: z.number().int().nonnegative(),
  payload: z.string(),
  tags: z.array(z.string()),
  nested: z.object({
    level: z.number().int().nonnegative(),
    active: z.boolean(),
  }),
});

const fixedDate = new Date('2024-01-01T00:00:00.000Z');

function checksum(input: string): number {
  let value = 0;
  for (let index = 0; index < input.length; index += 1) {
    value = (value + input.charCodeAt(index) * (index + 1)) % 1_000_000_007;
  }
  return value;
}

export const benchmarkRouter = t.router({
  payloadRoundtrip: t.procedure.input(benchInputSchema).query(({ input, ctx }) => {
    return {
      ok: true,
      id: input.id,
      payload: input.payload,
      payloadLength: input.payload.length,
      tags: input.tags,
      nested: input.nested,
      requestId: ctx.requestId,
      callerService: ctx.callerService,
      checksum: checksum(input.payload),
      echoedAt: fixedDate,
    };
  }),
});

export type BenchmarkRouter = typeof benchmarkRouter;
export type BenchmarkInput = z.infer<typeof benchInputSchema>;

function readHeader(
  value: string | string[] | undefined,
): string | null {
  if (Array.isArray(value)) {
    return typeof value[0] === 'string' ? value[0] : null;
  }
  return typeof value === 'string' ? value : null;
}

function readMetadataValue(metadata: grpc.Metadata, key: string): string | null {
  const value = metadata.get(key)[0];
  return typeof value === 'string' ? value : null;
}

function readOperationRequestId(opContext: Record<string, unknown>): string {
  const value = opContext['requestId'];
  return typeof value === 'string' ? value : 'benchmark-request';
}

export function createBenchmarkInput(size: 'tiny' | 'medium'): BenchmarkInput {
  const payload =
    size === 'tiny'
      ? 'x'.repeat(64)
      : JSON.stringify({
          note: 'medium-payload',
          body: 'x'.repeat(4_096),
          metadata: Array.from({ length: 24 }, (_, index) => `tag-${index}`),
        });

  return {
    id: size === 'tiny' ? 1 : 2,
    payload,
    tags: Array.from({ length: size === 'tiny' ? 4 : 24 }, (_, index) => `tag-${index}`),
    nested: {
      level: size === 'tiny' ? 1 : 4,
      active: true,
    },
  };
}

export interface RunningBenchmarkServers {
  grpcAddress: string;
  httpUrl: string;
  close: () => Promise<void>;
}

export async function startBenchmarkServers(): Promise<RunningBenchmarkServers> {
  const grpcServer = new grpc.Server();
  addTRPCToGRPCServer(grpcServer, {
    router: benchmarkRouter,
    createContext({ metadata }) {
      return {
        requestId: readMetadataValue(metadata, 'x-request-id'),
        callerService: readMetadataValue(metadata, 'x-caller-service'),
      };
    },
  });

  const grpcPort = await new Promise<number>((resolve, reject) => {
    grpcServer.bindAsync(
      '127.0.0.1:0',
      grpc.ServerCredentials.createInsecure(),
      (error, port) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      },
    );
  });

  const httpServer = createHTTPServer({
    basePath: '/trpc/',
    router: benchmarkRouter,
    createContext({ req }) {
      return {
        requestId: readHeader(req.headers['x-request-id']),
        callerService: readHeader(req.headers['x-caller-service']),
      };
    },
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const httpAddress = httpServer.address();
  if (!httpAddress || typeof httpAddress === 'string') {
    throw new Error('Unable to determine benchmark HTTP server address');
  }

  return {
    grpcAddress: `127.0.0.1:${grpcPort}`,
    httpUrl: `http://127.0.0.1:${httpAddress.port}/trpc`,
    async close() {
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeIdleConnections?.();
        httpServer.closeAllConnections?.();
      });

      await new Promise<void>((resolve, reject) => {
        grpcServer.tryShutdown((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

export interface BenchmarkClients {
  grpcClient: ReturnType<typeof createTRPCClient<BenchmarkRouter>>;
  httpClient: ReturnType<typeof createTRPCClient<BenchmarkRouter>>;
  close: () => void;
}

export function createBenchmarkClients(addresses: RunningBenchmarkServers): BenchmarkClients {
  const grpcTransportClient = new grpc.Client(
    addresses.grpcAddress,
    grpc.credentials.createInsecure(),
  );

  return {
    grpcClient: createTRPCClient<BenchmarkRouter>({
      links: [
        grpcLink({
          address: addresses.grpcAddress,
          credentials: grpc.credentials.createInsecure(),
          client: grpcTransportClient,
          transformer: superjson,
          metadata({ op }) {
            return {
              'x-request-id': readOperationRequestId(op.context),
              'x-caller-service': 'benchmark-runner',
            };
          },
        }),
      ],
    }),
    httpClient: createTRPCClient<BenchmarkRouter>({
      links: [
        httpLink({
          url: addresses.httpUrl,
          transformer: superjson,
          headers({ op }) {
            return {
              'x-request-id': readOperationRequestId(op.context),
              'x-caller-service': 'benchmark-runner',
            };
          },
        }),
      ],
    }),
    close() {
      grpcTransportClient.close();
    },
  };
}

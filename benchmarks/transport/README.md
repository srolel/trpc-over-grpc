# Transport benchmark

This benchmark compares:

- `grpcLink(...)` from this package
- standard tRPC `httpLink(...)`

It uses:

- the same router
- the same resolver logic
- the same `superjson` transformer
- loopback networking on the same machine

## Why `httpLink` instead of `httpBatchLink`?

`grpcLink` is a unary request transport today, so `httpLink` is the closest apples-to-apples comparison.

## Run

```bash
npm install
npm run benchmark:transport
```

## Tunables

You can override the defaults with environment variables:

```bash
BENCH_WARMUP=100 BENCH_ITERATIONS=1000 BENCH_CONCURRENCY=64 npm run benchmark:transport
```

Defaults:

- `BENCH_WARMUP=200`
- `BENCH_ITERATIONS=2000`
- `BENCH_CONCURRENCY=64`

## What it measures

Scenarios:

- tiny payload, sequential
- tiny payload, concurrent
- medium payload, sequential
- medium payload, concurrent

Reported metrics:

- total wall time
- requests/sec
- average latency
- p50 / p95 / p99 latency

## Important caveats

This is a microbenchmark, not a production capacity test.

It reflects the performance of the **current implementation**, which uses:

- gRPC transport
- JSON-serialized tRPC envelopes
- no protobuf encoding yet

If the transport later moves to protobuf, rerun the same benchmark to get an updated comparison.

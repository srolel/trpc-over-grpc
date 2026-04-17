import type { TRPCClient } from "@trpc/client";
import { TRPCError, initTRPC } from "@trpc/server";
import superjson from "superjson";
import { z } from "zod";
import type { UserServiceRouter } from "./user-service.contract.js";

export interface OrderServiceContext {
  requestId: string | null;
}

const t = initTRPC.context<OrderServiceContext>().create({
  transformer: superjson,
});

const orders = {
  order_1: {
    id: "order_1",
    userId: "user_1",
    sku: "enterprise-plan",
    totalCents: 4200,
    currency: "USD",
  },
  order_2: {
    id: "order_2",
    userId: "user_2",
    sku: "pro-plan",
    totalCents: 1900,
    currency: "USD",
  },
} as const;

export function createOrderServiceRouter(deps: {
  userService: TRPCClient<UserServiceRouter>;
}) {
  return t.router({
    orderSummaryById: t.procedure
      .input(
        z.object({
          orderId: z.string(),
        }),
      )
      .query(async ({ input, ctx }) => {
        const order = orders[input.orderId as keyof typeof orders];

        if (!order) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `No order found for id ${input.orderId}`,
          });
        }

        const user = await deps.userService.userById.query(
          { id: order.userId },
          {
            context: {
              grpcMetadata: {
                "x-request-id": ctx.requestId ?? "missing-request-id",
              },
            },
          },
        );

        return {
          orderId: order.id,
          sku: order.sku,
          totalCents: order.totalCents,
          currency: order.currency,
          requestId: ctx.requestId,
          handledBy: "order-service",
          user,
        };
      }),
  });
}

export type OrderServiceRouter = ReturnType<typeof createOrderServiceRouter>;

import Fastify from "fastify";

import { registerTestInvoiceRoute } from "./modules/invoices/test-invoice.route.js";
import { env } from "./shared/env.js";
import { requireDevApiKey } from "./shared/devAuth.js";

const app = Fastify({
  logger:
    env.nodeEnv === "development"
      ? { transport: { target: "pino-pretty" } }
      : true,
});

app.get("/health", async () => ({ status: "ok" }));

await app.register(async (devRoutes) => {
  devRoutes.addHook("onRequest", requireDevApiKey);
  await registerTestInvoiceRoute(devRoutes);
});

app.listen({ port: env.port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

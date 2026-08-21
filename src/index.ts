import Fastify from "fastify";

import { env } from "./shared/env.js";

const app = Fastify({
  logger:
    env.nodeEnv === "development"
      ? { transport: { target: "pino-pretty" } }
      : true,
});

app.get("/health", async () => ({ status: "ok" }));

app.listen({ port: env.port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

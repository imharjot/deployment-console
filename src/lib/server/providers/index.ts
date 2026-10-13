// Every provider the inventory runs, grouped by who maintains them. Adding a service = one file under this folder,
// exported from its group. Order doesn't matter for resources (they are merged by key), except that the catch-all
// comes last: it keeps out of its generic rows whatever the first-class providers before it cover.
import "server-only";
import { catchallProvider } from "./catchall.ts";
import { providers as compute } from "./compute.ts";
import { providers as databases } from "./databases.ts";
import { declaredProvider } from "./declared.ts";
import { providers as delivery } from "./delivery.ts";
import { providers as ecs } from "./ecs.ts";
import { providers as edge } from "./edge.ts";
import { providers as ml } from "./ml.ts";
import { providers as network } from "./network.ts";
import { providers as observability } from "./observability.ts";
import { providers as platforms } from "./platforms.ts";
import { providers as security } from "./security.ts";
import { providers as serverless } from "./serverless.ts";
import type { Provider } from "./types.ts";

export const PROVIDERS: Provider[] = [
  ...ecs, ...compute, ...serverless, ...edge, declaredProvider,
  ...network, ...security, ...observability, ...delivery, ...databases, ...platforms, ...ml,
  catchallProvider,
];
export const providerById = (id: string) => PROVIDERS.find((p) => p.id === id);

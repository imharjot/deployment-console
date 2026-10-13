// The scripted model (no network, deterministic) with the built-in demo script registered — the model of the mock
// mode's built-in "scripted:demo" connection. Scripts and failure counters live on globalThis (see scripted.ts).
import "server-only";
import { createScriptedAdapter } from "../../../agents/inference/scripted.ts";
import { INCIDENT_DEMO, incidentDemo } from "../../../agents/inference/scripts/incident-demo.ts";

export const scriptedAdapter = createScriptedAdapter({ scripts: [incidentDemo], defaultScript: INCIDENT_DEMO });

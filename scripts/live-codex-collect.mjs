import { mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { JsonStore } from "../src/storage/json-store.mjs";
import { loadSeedState } from "../src/services/bootstrap.mjs";
import { GeoOsService } from "../src/services/geo-os-service.mjs";
import { LivePipelineService } from "../src/services/live-pipeline.mjs";
import { PersonalGeoEngine } from "../src/engines/geo-evidence.mjs";

const rootDir = resolve(import.meta.dirname, "..");
const dataDir = join(rootDir, "data", "seed");
const stateFile = resolve(
  rootDir,
  process.env.LIVE_STATE_FILE || "var/live-codex-state.json",
);
const limit = Number(process.env.LIVE_QUERY_LIMIT || 12);
const store = new JsonStore({ filePath: stateFile });
await store.open(() => loadSeedState(dataDir));
const service = new GeoOsService({ store });
const geoEngine = new PersonalGeoEngine({
  rootDir, databasePath: join(rootDir, "var", "live-codex-geo.sqlite"), controlQueries: store.snapshot().queries,
});
const live = new LivePipelineService({ service, geoEngine });
let result;
try {
  result = await live.collectCodex({ limit });
} finally {
  geoEngine.close();
}
const timestamp = new Date().toISOString();
const date = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());
const evidenceDir = join(rootDir, "var", "evidence");
const receiptDir = join(rootDir, "var", "receipts");
await Promise.all([
  mkdir(evidenceDir, { recursive: true, mode: 0o700 }),
  mkdir(receiptDir, { recursive: true, mode: 0o700 }),
]);

await writeFile(
  join(evidenceDir, `codex-live-${result.runId}-full.json`),
  `${JSON.stringify({ timestamp, stateFile, result }, null, 2)}\n`,
  { encoding: "utf8", mode: 0o600 },
);

const sanitized = {
  schemaVersion: "pengstack.live-receipt/v1",
  kind: "codex-search-baseline",
  completedAt: timestamp,
  provider: result.provider,
  stateFile: relative(rootDir, stateFile),
  requested: result.requested,
  successful: result.successful,
  failed: result.failed,
  metrics: result.metrics,
  receiptHash: result.receiptHash,
  queries: result.results.map((item) => ({
    queryId: item.queryId,
    status: item.status,
    observationId: item.observationId ?? null,
    answerHash: item.answerHash ?? null,
    model: item.evidence?.model ?? null,
    evidenceHash: item.evidence?.evidenceHash ?? null,
    citationCount: item.evidence?.citations?.length ?? 0,
    error: item.error ?? null,
  })),
};
await writeFile(
  join(receiptDir, `codex-live-${date}-${result.runId}.json`),
  `${JSON.stringify(sanitized, null, 2)}\n`,
  { encoding: "utf8", mode: 0o600 },
);

console.log(JSON.stringify(sanitized, null, 2));
if (result.failed > 0) {
  process.exitCode = 1;
}

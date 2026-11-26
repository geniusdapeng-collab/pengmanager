import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createGeoStudioServer } from "../engines/geo-evidence/server.mjs";
import { GeoEvidenceAdapter } from "../src/adapters/geoevidence.mjs";

const rootDir = resolve(import.meta.dirname, "..");
const evidenceRoot = join(rootDir, "var", "live-geoevidence");
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const token = randomBytes(32).toString("base64url");
const application = createGeoStudioServer({
  rootDir: evidenceRoot,
  dbPath: join(evidenceRoot, "geo-evidence.sqlite"),
  token,
});
try {
  const { port } = await application.listen({ port: 0, host: "127.0.0.1" });
  const adapter = new GeoEvidenceAdapter({ baseUrl: `http://127.0.0.1:${port}`, token });
  const queries = await adapter.listQueries();
  const queryId = process.env.GEO_EVIDENCE_QUERY_ID || queries[0]?.id;
  if (!queryId) throw new Error("GeoEvidence 没有可用查询。");
  const run = await adapter.runVisibility({ queryId });
  const receipt = {
    schemaVersion: "pengstack.live-receipt/v1",
    kind: "geoevidence-codex-http-adapter",
    completedAt: new Date().toISOString(),
    queryId,
    provider: run.provider,
    run,
  };
  const contents = `${JSON.stringify(receipt, null, 2)}\n`;
  await writeFile(join(evidenceRoot, `receipt-${run.runId}.json`), contents, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(contents);
} finally {
  await application.close();
}

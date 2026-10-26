// ingest the knowledge base and report what was (re)embedded.
// usage: npm run ingest            (uses openai, needs OPENAI_API_KEY)
//        npm run ingest -- --dry   (no api calls, just validates and chunks)
import "dotenv/config";
import { settings } from "../src/config.js";
import { chunkDocs } from "../src/kb/chunker.js";
import { loadDocs } from "../src/kb/loader.js";
import { buildIndex } from "../src/kb/build.js";

const dry = process.argv.includes("--dry");
const t0 = Date.now();

if (dry) {
  const docs = await loadDocs(settings.kbDir);
  const chunks = chunkDocs(docs, settings);
  console.log(`docs: ${docs.length} (${docs.filter((d) => d.supersededBy).length} archived)`);
  console.log(`chunks: ${chunks.length}`);
  for (const c of chunks) console.log(`  ${c.archived ? "[archived] " : ""}${c.id}  (${c.text.split(/\s+/).length} words)`);
} else {
  const { docs, retriever, embedder } = await buildIndex();
  console.log(`docs: ${docs.length}, chunks: ${retriever.chunks.length}`);
  console.log(`embeddings: ${embedder.stats.hits} from cache, ${embedder.stats.misses} newly embedded`);
}
console.log(`done in ${Date.now() - t0}ms`);

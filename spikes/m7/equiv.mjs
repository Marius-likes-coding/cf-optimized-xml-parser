/**
 * M7: two parser entry points must produce identical trees (and identical accept/reject) on
 * every matrix fixture, the unit-test edge cases' style of inputs, and fuzzed variants.
 * Usage: node spikes/m7/equiv.mjs <entry-a.ts> <entry-b.ts>
 */
import { buildSync } from "esbuild";
import { readdirSync, readFileSync } from "node:fs";

async function load(entry) {
  const code = buildSync({ entryPoints: [entry], bundle: true, format: "esm", write: false }).outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}
const [a, b] = await Promise.all(process.argv.slice(2, 4).map(load));
const run = (parser, xml) => {
  try {
    return JSON.stringify(parser.parse(xml));
  } catch (error) {
    return `THROW ${error.constructor.name}`;
  }
};
const dir = "test/fixtures/generated/matrix";
const docs = readdirSync(dir).map((file) => readFileSync(`${dir}/${file}`, "utf8"));
docs.push("<ü:ñ ç·a-b.c_d='1' ζ='2'>x</ü:ñ>", "<a𐀀 b𐀀='1'/>", "<1a/>", "<a$b/>", "<a b$c='1'/>", "<a:b:c d:e='1'/>");
let differences = 0;
for (const xml of docs) {
  // Each document plus 200 single-character mutations of it.
  for (let variant = 0; variant <= 200; variant++) {
    const at = (variant * 7919) % (xml.length + 1);
    const input = variant === 0 ? xml : xml.slice(0, at) + "<>=\"'&/:-é𐀀 "[variant % 13] + xml.slice(at + 1);
    if (run(a, input) !== run(b, input)) differences++;
  }
}
console.log(differences === 0 ? `SAME on ${docs.length * 201} inputs` : `${differences} DIFFERENT`);
process.exitCode = differences === 0 ? 0 : 1;

import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const directory = fileURLToPath(new URL("../build/desktop/update-fixture/", import.meta.url));
await mkdir(directory, { recursive: true });
const transportTest = process.argv.includes("--transport-test");
const artifact = transportTest ? join(directory, "transport-test.exe") : fileURLToPath(new URL("../build/desktop/dist/Weclio-0.1.10-x64-Setup.exe", import.meta.url));
if (transportTest) await writeFile(artifact, "NOT AN INSTALLER — download transport test only\n");
const { size } = await stat(artifact);
const hash = createHash("sha512");
for await (const chunk of createReadStream(artifact)) hash.update(chunk);
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const server = createServer((request, response) => {
  if (request.url === "/manifest.json") {
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(manifest);
    return;
  }
  if (request.url !== "/Weclio-fixture-Setup.exe") { response.writeHead(404); response.end(); return; }
  let start = 0;
  let end = size - 1;
  if (request.headers.range) {
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
    if (!range || (start = Number(range[1])) > end || (range[2] && (end = Number(range[2])) >= size) || end < start) {
      response.writeHead(416, { "Content-Range": `bytes */${size}` }); response.end(); return;
    }
    response.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
  }
  response.writeHead(request.headers.range ? 206 : 200, { "Content-Type": "application/octet-stream", "Content-Length": end - start + 1, "Accept-Ranges": "bytes" });
  const stream = createReadStream(artifact, { start, end });
  response.on("close", () => stream.destroy());
  stream.on("error", (error) => response.destroy(error));
  stream.pipe(response);
});
let manifest;
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(8899, "127.0.0.1", resolve); });
const base = "http://127.0.0.1:8899";
const payload = Buffer.from(JSON.stringify({ version: "99.0.0", files: [{ url: `${base}/Weclio-fixture-Setup.exe`, sha512: hash.digest("base64"), size }] }));
manifest = JSON.stringify({ payload: payload.toString("base64"), signature: sign(null, payload, privateKey).toString("base64") });
const config = join(directory, "desktop-update.json");
await writeFile(config, JSON.stringify({ manifestUrl: `${base}/manifest.json`, publicKey: publicKey.export({ type: "spki", format: "pem" }), devFixture: true }, null, 2));
console.log(`Fixture: ${artifact}\n${size} bytes; ${transportTest ? "TRANSPORT TEST, NOT AN INSTALLER" : "real existing installer"}`);
console.log("Advertised 99.0.0 is NOT the embedded installer version. Stage 1 must NEVER install it.");
console.log(`PowerShell (another terminal):\n$env:WECLIO_UPDATE_CONFIG='${config}'\nnpm run dev:desktop`);
console.log(`Feed: ${base}/manifest.json (Ctrl+C to stop; no upload/release)`);

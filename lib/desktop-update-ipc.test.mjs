import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { createUpdateGate } from "../electron/update-gate.mjs";

const script = `
  import { createJiti } from 'jiti';
  const jiti = createJiti(import.meta.url);
  const { registerDesktopUpdateGate, beginDesktopTask } = await jiti.import(${JSON.stringify(new URL("./desktop-update-gate.ts", import.meta.url).href)});
  registerDesktopUpdateGate(() => false);
  registerDesktopUpdateGate(() => { throw Error('Duplicate registration'); });
  process.on('disconnect', () => {
    const finish = beginDesktopTask(); finish();
    console.log('released');
  });
  process.send({type:'fixture-ready'});
`;

test("production child processes ordered lock/unlock synchronously and disconnect releases lock", async (t) => {
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(), env: { ...process.env, NODE_ENV: "production", WECLIO_DESKTOP_UPDATE_IPC: "1" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  t.after(() => child.kill());
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const exited = once(child, "exit");
  const first = await once(child, "message");
  assert.equal(first[0].type, "fixture-ready");
  const gate = createUpdateGate(child);
  t.after(() => gate.dispose());
  const locked = gate.lock();
  const unlocked = gate.unlock();
  assert.equal(await locked, "ready");
  await unlocked;
  assert.equal(await gate.lock(), "ready");
  child.disconnect();
  const [code] = await exited;
  assert.equal(code, 0, errors);
  assert.match(output, /released/);
});

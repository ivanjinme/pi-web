import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

async function loadSubject() {
  return import("./directory-browser.ts");
}

test("lists directories without returning files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-web-browse-"));
  try {
    await mkdir(path.join(root, "project"));
    await writeFile(path.join(root, "notes.txt"), "test", "utf8");

    const { listDirectories } = await loadSubject();
    const directories = await listDirectories(root);

    assert.deepEqual(directories.map((entry) => entry.name), ["project"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lists directory symlinks", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-web-browse-"));
  try {
    await mkdir(path.join(root, "project"));
    try {
      await symlink(path.join(root, "project"), path.join(root, "linked-project"), "dir");
    } catch (error) {
      if (process.platform === "win32" && error?.code === "EPERM") {
        t.skip("Creating symbolic links requires additional privileges on this platform");
        return;
      }
      throw error;
    }

    const { listDirectories } = await loadSubject();
    const directories = await listDirectories(root);

    assert.deepEqual(directories.map((entry) => entry.name), ["linked-project", "project"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("expands home-relative paths and rejects missing directories", async () => {
  const { getBrowseStartDirectory, normalizeDirectory, resolveDirectory } = await loadSubject();
  assert.equal(getBrowseStartDirectory(), homedir());
  assert.equal(getBrowseStartDirectory("/project"), "/project");
  assert.equal(normalizeDirectory("~/project"), path.join(homedir(), "project"));
  await assert.rejects(resolveDirectory(path.join(tmpdir(), `pi-web-missing-${Date.now()}`)));
});

test("finds parent directories across POSIX and Windows paths", async () => {
  const { getParentDirectory } = await loadSubject();

  assert.equal(getParentDirectory("/Users/alex/project"), "/Users/alex");
  assert.equal(getParentDirectory("/"), null);
  assert.equal(getParentDirectory("C:\\Users\\Alex\\project"), "C:\\Users\\Alex");
  assert.equal(getParentDirectory("C:\\"), null);
  assert.equal(getParentDirectory("C:/Users/Alex/project/"), "C:\\Users\\Alex");
  assert.equal(getParentDirectory("\\\\server\\share\\project"), "\\\\server\\share\\");
  assert.equal(getParentDirectory("\\\\server\\share\\"), null);
  assert.equal(getParentDirectory("//server/share/project"), "\\\\server\\share\\");
  assert.equal(getParentDirectory("//server/share/"), null);
  assert.equal(getParentDirectory("\\Users\\Alex\\project"), "\\Users\\Alex");
  assert.equal(getParentDirectory("\\"), null);
});

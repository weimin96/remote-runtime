import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { RemoteHost } from "../src/server/host-registry.js";
import { SftpClient } from "../src/server/sftp-client.js";

test("lists SFTP directories and previews text through system sftp", async (context) => {
  if (process.platform === "win32") return context.skip("fake sftp executable test requires POSIX");
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-ssh-sftp-test-"));
  const fakeSftp = path.join(root, "sftp");
  await writeFile(
    fakeSftp,
    `#!/bin/sh
printf '%s\n' "$*" > "${path.join(root, "invocation.log")}"
input=$(cat)
case "$input" in
  *get*)
    local_path=$(printf '%s\n' "$input" | sed -n 's/^get "[^"]*" "\\(.*\\)"$/\\1/p')
    printf '# test file\nhello remote\n' > "$local_path"
    ;;
  *)
    cat <<'OUT'
sftp> cd "/srv/app"
sftp> pwd
Remote working directory: /srv/app
sftp> ls -lan
drwxr-xr-x    ? deploy   deploy       4096 Oct  5 12:00 .
drwxr-xr-x    ? root     root         4096 Oct  5 11:00 ..
drwxr-xr-x    ? deploy   deploy       4096 Oct  5 12:00 config files
-rw-r--r--    ? deploy   deploy        128 Oct  5 12:01 app.txt
lrwxrwxrwx    ? deploy   deploy          7 Oct  5 12:02 current -> app.txt
sftp> quit
OUT
    ;;
esac
`,
  );
  await chmod(fakeSftp, 0o755);
  const previousPath = process.env.PATH;
  const previousConfig = process.env.REMOTE_SSH_CONFIG;
  process.env.PATH = `${root}:${previousPath ?? ""}`;
  process.env.REMOTE_SSH_CONFIG = path.join(root, "config");
  await writeFile(process.env.REMOTE_SSH_CONFIG, "Host example\n  HostName example.invalid\n");
  const host: RemoteHost = {
    id: "example",
    alias: "example",
    hostname: "example.invalid",
    user: "deploy",
    port: 22,
    identityFiles: [],
    proxyJump: null,
    resolved: true,
    source: "ssh-config",
    identityFile: null,
    defaultCwd: "/srv/app",
  };
  try {
    const client = new SftpClient();
    const directory = await client.listDirectory(host);
    assert.equal(directory.path, "/srv/app");
    assert.deepEqual(directory.entries.map((entry) => [entry.name, entry.type]), [
      ["config files", "directory"],
      ["current", "symlink"],
      ["app.txt", "file"],
    ]);
    assert.equal(directory.entries.find((entry) => entry.name === "app.txt")?.size, 128);
    assert.equal(directory.entries.find((entry) => entry.name === "current")?.linkTarget, "app.txt");

    const preview = await client.readText(host, "/srv/app/app.txt", 8);
    assert.equal(preview.path, "/srv/app/app.txt");
    assert.equal(preview.text, "# test f");
    assert.equal(preview.truncated, true);
    const invocation = await readFile(path.join(root, "invocation.log"), "utf8").catch(() => "");
    if (invocation) assert.match(invocation, /-- example/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousConfig === undefined) delete process.env.REMOTE_SSH_CONFIG;
    else process.env.REMOTE_SSH_CONFIG = previousConfig;
  }
});

test("rejects oversized and invalid UTF-8 SFTP previews after download", async (context) => {
  if (process.platform === "win32") return context.skip("fake sftp executable test requires POSIX");
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-ssh-sftp-preview-test-"));
  const fakeSftp = path.join(root, "sftp");
  await writeFile(
    fakeSftp,
    `#!/bin/sh
input=$(cat)
case "$input" in
  *get*)
    local_path=$(printf '%s\n' "$input" | sed -n 's/^get "[^"]*" "\\(.*\\)"$/\\1/p')
    case "$input" in
      *oversized.txt*) dd if=/dev/zero of="$local_path" bs=1048576 count=3 >/dev/null 2>&1 ;;
      *invalid.txt*) printf '\\377\\376\\375' > "$local_path" ;;
      *) printf 'ok' > "$local_path" ;;
    esac
    ;;
  *) : ;;
esac
`,
  );
  await chmod(fakeSftp, 0o755);
  const previousPath = process.env.PATH;
  const previousConfig = process.env.REMOTE_SSH_CONFIG;
  process.env.PATH = `${root}:${previousPath ?? ""}`;
  process.env.REMOTE_SSH_CONFIG = path.join(root, "config");
  await writeFile(process.env.REMOTE_SSH_CONFIG, "Host example\n  HostName example.invalid\n");
  const host: RemoteHost = {
    id: "example",
    alias: "example",
    hostname: "example.invalid",
    user: "deploy",
    port: 22,
    identityFiles: [],
    proxyJump: null,
    resolved: true,
    source: "ssh-config",
    identityFile: null,
    defaultCwd: "/srv/app",
  };
  try {
    const client = new SftpClient();
    await assert.rejects(() => client.readText(host, "/srv/app/oversized.txt"), /超过 .*文本预览上限/);
    await assert.rejects(() => client.readText(host, "/srv/app/invalid.txt"), /不是有效 UTF-8 文本/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousConfig === undefined) delete process.env.REMOTE_SSH_CONFIG;
    else process.env.REMOTE_SSH_CONFIG = previousConfig;
  }
});

test("supports SFTP writes, rename, mkdir and chunked transfers", async (context) => {
  if (process.platform === "win32") return context.skip("fake sftp executable test requires POSIX");
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-ssh-sftp-write-test-"));
  const fakeSftp = path.join(root, "sftp");
  const logPath = path.join(root, "commands.log");
  const uploadedPath = path.join(root, "uploaded.bin");
  await writeFile(
    fakeSftp,
    `#!/bin/sh
input=$(cat)
printf '%s\n---\n' "$input" >> "${logPath}"
case "$input" in
  *get*)
    local_path=$(printf '%s\n' "$input" | sed -n 's/^get "[^"]*" "\\(.*\\)"$/\\1/p')
    printf 'download-body' > "$local_path"
    ;;
  *put*)
    local_path=$(printf '%s\n' "$input" | sed -n 's/^put "\\([^"]*\\)" ".*"$/\\1/p')
    cp "$local_path" "${uploadedPath}"
    ;;
esac
`,
  );
  await chmod(fakeSftp, 0o755);
  const previousPath = process.env.PATH;
  const previousConfig = process.env.REMOTE_SSH_CONFIG;
  const previousHome = process.env.HOME;
  process.env.PATH = `${root}:${previousPath ?? ""}`;
  process.env.HOME = root;
  process.env.REMOTE_SSH_CONFIG = path.join(root, "config");
  await writeFile(process.env.REMOTE_SSH_CONFIG, "Host example\n  HostName example.invalid\n");
  const host: RemoteHost = {
    id: "example",
    alias: "example",
    hostname: "example.invalid",
    user: "deploy",
    port: 22,
    identityFiles: [],
    proxyJump: null,
    resolved: true,
    source: "ssh-config",
    identityFile: null,
    defaultCwd: "/srv/app",
  };
  try {
    const client = new SftpClient();
    await client.mkdir(host, "/srv/app/new-dir");
    await client.rename(host, "/srv/app/a.txt", "/srv/app/b.txt");
    await client.remove(host, "/srv/app/b.txt", "file");
    await client.writeText(host, "/srv/app/config.txt", "edited text\n");
    assert.equal(await readFile(uploadedPath, "utf8"), "edited text\n");

    const upload = await client.beginUpload();
    const otherRuntime = new SftpClient();
    await assert.rejects(
      () => otherRuntime.appendUploadChunk(upload.uploadId, Buffer.from("wrong-runtime").toString("base64")),
      /已随 Remote SSH runtime 结束/,
    );
    await client.appendUploadChunk(upload.uploadId, Buffer.from("chunk-one\n").toString("base64"));
    await client.appendUploadChunk(upload.uploadId, Buffer.from("chunk-two\n").toString("base64"));
    const committed = await client.commitUpload(host, upload.uploadId, "/srv/app/upload.bin");
    assert.equal(committed.size, Buffer.byteLength("chunk-one\nchunk-two\n"));
    assert.equal(await readFile(uploadedPath, "utf8"), "chunk-one\nchunk-two\n");

    const log = await readFile(logPath, "utf8");
    assert.match(log, /mkdir "\/srv\/app\/new-dir"/);
    assert.match(log, /rename "\/srv\/app\/a\.txt" "\/srv\/app\/b\.txt"/);
    assert.match(log, /rm "\/srv\/app\/b\.txt"/);
    assert.match(log, /put .*"\/srv\/app\/upload\.bin"/);
    await assert.rejects(() => client.mkdir(host, "/srv/app/bad\npath"), /不能包含换行/);

    const download = await client.beginDownload(host, "/srv/app/download.bin", Buffer.byteLength("download-body"));
    let status = download;
    const deadline = Date.now() + 3000;
    while (status.status === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      status = await client.downloadStatus(download.downloadId);
    }
    assert.equal(status.status, "completed");
    assert.equal(status.received, Buffer.byteLength("download-body"));
    assert.equal(await readFile(status.localPath, "utf8"), "download-body");
    const downloadEntries = await readdir(path.dirname(status.localPath));
    assert.equal(downloadEntries.some((name) => name.includes(".remote-ssh-") && name.endsWith(".part")), false);
    await client.close();
    await otherRuntime.close();
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousConfig === undefined) delete process.env.REMOTE_SSH_CONFIG;
    else process.env.REMOTE_SSH_CONFIG = previousConfig;
  }
});

test("cancels async SFTP downloads without leaving partial files", async (context) => {
  if (process.platform === "win32") return context.skip("fake sftp executable test requires POSIX");
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-ssh-sftp-cancel-test-"));
  const fakeSftp = path.join(root, "sftp");
  await writeFile(
    fakeSftp,
    `#!/bin/sh
input=$(cat)
local_path=$(printf '%s\n' "$input" | sed -n 's/^get "[^"]*" "\\(.*\\)"$/\\1/p')
if [ -n "$local_path" ]; then
  printf 'partial' > "$local_path"
  sleep 5
fi
`,
  );
  await chmod(fakeSftp, 0o755);
  const previousPath = process.env.PATH;
  const previousConfig = process.env.REMOTE_SSH_CONFIG;
  const previousHome = process.env.HOME;
  process.env.PATH = `${root}:${previousPath ?? ""}`;
  process.env.HOME = root;
  process.env.REMOTE_SSH_CONFIG = path.join(root, "config");
  await writeFile(process.env.REMOTE_SSH_CONFIG, "Host example\n  HostName example.invalid\n");
  const host: RemoteHost = {
    id: "example", alias: "example", hostname: "example.invalid", user: "deploy", port: 22,
    identityFiles: [], proxyJump: null, resolved: true, source: "ssh-config", identityFile: null, defaultCwd: "/srv/app",
  };
  const client = new SftpClient();
  try {
    const download = await client.beginDownload(host, "/srv/app/large.bin", 1024);
    const progressDeadline = Date.now() + 1500;
    let status = await client.downloadStatus(download.downloadId);
    while (status.received === 0 && Date.now() < progressDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      status = await client.downloadStatus(download.downloadId);
    }
    assert.ok(status.received > 0, "download should expose partial byte progress before cancellation");
    const cancelled = await client.cancelDownload(download.downloadId);
    assert.equal(cancelled.status, "cancelled");
    const downloads = path.join(root, "Downloads");
    const names = await readdir(downloads);
    assert.equal(names.some((name) => name.includes(".remote-ssh-") && name.endsWith(".part")), false);
    assert.equal(names.includes("large.bin"), false);
  } finally {
    await client.close();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousConfig === undefined) delete process.env.REMOTE_SSH_CONFIG;
    else process.env.REMOTE_SSH_CONFIG = previousConfig;
  }
});

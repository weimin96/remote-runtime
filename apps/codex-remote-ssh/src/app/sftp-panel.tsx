import React, { useCallback, useEffect, useRef, useState } from "react";
import { AlertDialog, Button, Dialog, DropdownMenu, Flex, IconButton, ScrollArea, Select, TextField, Tooltip } from "@radix-ui/themes";
import { ArchiveIcon, ChevronLeftIcon, ChevronRightIcon, CopyIcon, Cross1Icon, DotsHorizontalIcon, DoubleArrowLeftIcon, DoubleArrowRightIcon, DownloadIcon, FileIcon, FilePlusIcon, Link2Icon, Pencil2Icon, ReloadIcon, TrashIcon, UploadIcon } from "@radix-ui/react-icons";

import { request, requestReadOnly, userFacingError } from "./runtime.js";
import type { CommandRun, Host, SftpDirectory, SftpDownloadStatus, SftpEntry } from "./types.js";

function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "—";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function parentRemotePath(value: string): string {
  if (!value || value === "/") return "/";
  const normalized = value.replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}

function joinRemotePath(directory: string, name: string): string {
  const base = directory === "/" ? "" : directory.replace(/\/+$/, "");
  return `${base}/${name}` || "/";
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + step, bytes.length)));
  }
  return btoa(binary);
}

export function SftpPanel({
  hosts,
  contextHost,
  contextCwd,
  refreshKey,
  agentRun,
  collapsed,
  onCollapsedChange,
}: {
  hosts: Host[];
  contextHost: string | null;
  contextCwd: string | null;
  refreshKey: string;
  agentRun: CommandRun | null;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}) {
  const [fileHost, setFileHost] = useState("");
  const [directory, setDirectory] = useState<SftpDirectory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ path: string; text: string; size: number; truncated: boolean } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editorText, setEditorText] = useState("");
  const [savingText, setSavingText] = useState(false);
  const [renameEntry, setRenameEntry] = useState<SftpEntry | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteEntry, setDeleteEntry] = useState<SftpEntry | null>(null);
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [newFileValue, setNewFileValue] = useState("");
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [mkdirValue, setMkdirValue] = useState("");
  const [transferLabel, setTransferLabel] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [changedPaths, setChangedPaths] = useState<Set<string>>(new Set());
  const [autoFollow, setAutoFollow] = useState(true);
  const [pathDraft, setPathDraft] = useState("");
  const [pathFocused, setPathFocused] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const snapshotsRef = useRef(new Map<string, Map<string, string>>());
  const entryRefs = useRef(new Map<string, HTMLDivElement>());
  const observedRunningRunsRef = useRef(new Set<string>());

  const copyRemotePath = async (path: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(path);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = path;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        textarea.setAttribute("readonly", "");
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand("copy");
        textarea.remove();
        if (!copied) throw new Error("当前宿主不允许写入剪贴板");
      }
      setTransferLabel(`已复制路径 · ${path}`);
      window.setTimeout(() => setTransferLabel(null), 2200);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "复制路径失败");
    }
  };

  const fingerprintEntries = (value: SftpDirectory) => new Map(
    value.entries.map((entry) => [entry.path, `${entry.type}:${entry.size}:${entry.modified}:${entry.permissions}`]),
  );

  const loadDirectory = useCallback(async (
    hostId: string,
    remotePath?: string | null,
    resetPreview = true,
    detectChanges = false,
  ) => {
    if (!hostId) return null;
    setLoading(true);
    setError(null);
    if (resetPreview) {
      setDirectory(null);
      setPreview(null);
    }
    try {
      const response = await requestReadOnly<{ isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: SftpDirectory }>(
        "tools/call",
        { name: "sftp.listDirectory", arguments: { host: hostId, ...(remotePath ? { path: remotePath } : {}) } },
        30_000,
      );
      if (response.isError || !response.structuredContent) throw new Error(response.content?.[0]?.text ?? "SFTP 目录读取失败");
      const nextDirectory = response.structuredContent;
      const snapshotKey = `${hostId}:${nextDirectory.path}`;
      const nextSnapshot = fingerprintEntries(nextDirectory);
      const previousSnapshot = snapshotsRef.current.get(snapshotKey);
      if (detectChanges && previousSnapshot) {
        const changed = new Set<string>();
        for (const [entryPath, fingerprint] of nextSnapshot) {
          if (previousSnapshot.get(entryPath) !== fingerprint) changed.add(entryPath);
        }
        for (const previousPath of previousSnapshot.keys()) {
          if (!nextSnapshot.has(previousPath)) changed.add(previousPath);
        }
        setChangedPaths(changed);
        if (changed.size > 0) window.setTimeout(() => setChangedPaths(new Set()), 8000);
      } else if (resetPreview) {
        setChangedPaths(new Set());
      }
      snapshotsRef.current.set(snapshotKey, nextSnapshot);
      setDirectory(nextDirectory);
      return nextDirectory;
    } catch (nextError) {
      setError(userFacingError(nextError, "SFTP 目录读取失败"));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (pathFocused) return;
    setPathDraft(directory?.path ?? "");
  }, [directory?.path, pathFocused]);

  useEffect(() => {
    const current = hosts.find((host) => host.id === fileHost && host.resolved);
    if (current) return;
    const first = hosts.find((host) => host.resolved);
    if (!first) return;
    setFileHost(first.id);
    void loadDirectory(first.id, first.defaultCwd || undefined);
  }, [fileHost, hosts, loadDirectory]);

  useEffect(() => {
    if (!contextHost || !autoFollow) return;
    const host = hosts.find((item) => item.id === contextHost || item.alias === contextHost);
    if (!host) return;
    const targetPath = contextCwd || host.defaultCwd || undefined;
    const timer = window.setTimeout(() => {
      setFileHost(host.id);
      void loadDirectory(host.id, targetPath, false, Boolean(refreshKey));
    }, 260);
    return () => window.clearTimeout(timer);
  }, [autoFollow, contextCwd, contextHost, directory?.path, hosts, loadDirectory, refreshKey]);

  useEffect(() => {
    const firstChanged = changedPaths.values().next().value as string | undefined;
    if (!firstChanged) return;
    requestAnimationFrame(() => entryRefs.current.get(firstChanged)?.scrollIntoView({ block: "center", behavior: "smooth" }));
  }, [changedPaths]);

  useEffect(() => {
    if (!agentRun || !autoFollow || !agentRun.startedAt || !agentRun.cwd) return;
    if (agentRun.status === "running") {
      observedRunningRunsRef.current.add(agentRun.sessionId);
      return;
    }
    if (!observedRunningRunsRef.current.delete(agentRun.sessionId)) return;
    if (agentRun.status === "interrupted") return;
    const host = hosts.find((item) => item.id === agentRun.host || item.alias === agentRun.host);
    if (!host) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await requestReadOnly<{
          isError?: boolean;
          structuredContent?: { supported?: boolean; files?: string[] };
        }>("tools/call", {
          name: "workspace.changedFiles",
          arguments: { host: host.id, cwd: agentRun.cwd, since: agentRun.startedAt, maxFiles: 200 },
        }, 15_000);
        if (cancelled || response.isError || !response.structuredContent?.supported) return;
        const files = response.structuredContent.files ?? [];
        if (files.length === 0) return;
        const targetDirectory = parentRemotePath(files[0]);
        setFileHost(host.id);
        await loadDirectory(host.id, targetDirectory, false, false);
        if (cancelled) return;
        const visibleChanges = new Set(files.filter((file) => parentRemotePath(file) === targetDirectory));
        setChangedPaths(visibleChanges);
        window.setTimeout(() => setChangedPaths(new Set()), 8000);
      } catch {
        // Directory snapshot refresh remains the fallback when remote find/newermt is unavailable.
      }
    })();
    return () => { cancelled = true; };
  }, [agentRun, autoFollow, hosts, loadDirectory]);

  const selectHost = (hostId: string) => {
    setAutoFollow(false);
    setFileHost(hostId);
    const host = hosts.find((item) => item.id === hostId);
    void loadDirectory(hostId, host?.defaultCwd || undefined);
  };

  const followContext = () => {
    if (!contextHost) return;
    const host = hosts.find((item) => item.id === contextHost || item.alias === contextHost);
    const hostId = host?.id ?? contextHost;
    setFileHost(hostId);
    setAutoFollow(true);
    void loadDirectory(hostId, contextCwd || host?.defaultCwd || undefined);
  };

  const openEntry = async (entry: SftpEntry) => {
    if (entry.type === "directory") {
      setAutoFollow(false);
      await loadDirectory(fileHost, entry.path);
      return;
    }
    if (entry.type !== "file" && entry.type !== "symlink") return;
    setPreviewLoading(true);
    setError(null);
    setPreview({ path: entry.path, text: "", size: entry.size, truncated: false });
    try {
      const response = await requestReadOnly<{
        isError?: boolean;
        content?: Array<{ text?: string }>;
        structuredContent?: { path?: string; text?: string; size?: number; truncated?: boolean };
      }>("tools/call", { name: "sftp.readText", arguments: { host: fileHost, path: entry.path, maxBytes: 512 * 1024 } }, 35_000);
      if (response.isError || !response.structuredContent) throw new Error(response.content?.[0]?.text ?? "文件预览失败");
      setPreview({
        path: String(response.structuredContent.path ?? entry.path),
        text: String(response.structuredContent.text ?? ""),
        size: Number(response.structuredContent.size ?? entry.size),
        truncated: Boolean(response.structuredContent.truncated),
      });
      setEditorText(String(response.structuredContent.text ?? ""));
      setEditing(false);
    } catch (nextError) {
      setError(userFacingError(nextError, "文件预览失败"));
    } finally {
      setPreviewLoading(false);
    }
  };

  const editEntry = async (entry: SftpEntry) => {
    await openEntry(entry);
    setEditing(true);
  };

  const saveText = async () => {
    if (!preview) return;
    setSavingText(true);
    setError(null);
    try {
      const response = await request<{ isError?: boolean; content?: Array<{ text?: string }> }>("tools/call", {
        name: "sftp.writeText",
        arguments: { host: fileHost, path: preview.path, text: editorText },
      }, 60_000);
      if (response.isError) throw new Error(response.content?.[0]?.text ?? "保存文件失败");
      setPreview((current) => current ? { ...current, text: editorText, size: new TextEncoder().encode(editorText).length, truncated: false } : current);
      setEditing(false);
      setChangedPaths(new Set([preview.path]));
      await loadDirectory(fileHost, directory?.path, false, true);
    } catch (nextError) {
      setError(userFacingError(nextError, "保存文件失败"));
    } finally {
      setSavingText(false);
    }
  };

  const renameRemote = async () => {
    if (!renameEntry || !directory || !renameValue.trim()) return;
    const nextPath = joinRemotePath(directory.path, renameValue.trim());
    setLoading(true);
    try {
      const response = await request<{ isError?: boolean; content?: Array<{ text?: string }> }>("tools/call", {
        name: "sftp.rename",
        arguments: { host: fileHost, from: renameEntry.path, to: nextPath },
      }, 40_000);
      if (response.isError) throw new Error(response.content?.[0]?.text ?? "重命名失败");
      setRenameEntry(null);
      setRenameValue("");
      setPreview(null);
      await loadDirectory(fileHost, directory.path, false, true);
      setChangedPaths(new Set([nextPath]));
    } catch (nextError) {
      setError(userFacingError(nextError, "重命名失败"));
    } finally {
      setLoading(false);
    }
  };

  const createDirectory = async () => {
    if (!directory || !mkdirValue.trim()) return;
    const nextPath = joinRemotePath(directory.path, mkdirValue.trim());
    setLoading(true);
    try {
      const response = await request<{ isError?: boolean; content?: Array<{ text?: string }> }>("tools/call", {
        name: "sftp.mkdir",
        arguments: { host: fileHost, path: nextPath },
      });
      if (response.isError) throw new Error(response.content?.[0]?.text ?? "新建目录失败");
      setMkdirOpen(false);
      setMkdirValue("");
      await loadDirectory(fileHost, directory.path, false, true);
      setChangedPaths(new Set([nextPath]));
    } catch (nextError) {
      setError(userFacingError(nextError, "新建目录失败"));
    } finally {
      setLoading(false);
    }
  };

  const createFile = async () => {
    if (!directory || !newFileValue.trim()) return;
    const name = newFileValue.trim();
    const nextPath = joinRemotePath(directory.path, name);
    if (directory.entries.some((entry) => entry.name === name)) {
      setError(`已存在同名文件或目录：${name}`);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await request<{ isError?: boolean; content?: Array<{ text?: string }> }>("tools/call", {
        name: "sftp.writeText",
        arguments: { host: fileHost, path: nextPath, text: "" },
      }, 40_000);
      if (response.isError) throw new Error(response.content?.[0]?.text ?? "新建文件失败");
      setNewFileOpen(false);
      setNewFileValue("");
      await loadDirectory(fileHost, directory.path, false, true);
      setChangedPaths(new Set([nextPath]));
    } catch (nextError) {
      setError(userFacingError(nextError, "新建文件失败"));
    } finally {
      setLoading(false);
    }
  };

  const removeRemote = async () => {
    if (!deleteEntry || !directory) return;
    const type = deleteEntry.type === "directory" ? "directory" : deleteEntry.type === "symlink" ? "symlink" : "file";
    setLoading(true);
    try {
      const response = await request<{ isError?: boolean; content?: Array<{ text?: string }> }>("tools/call", {
        name: "sftp.remove",
        arguments: { host: fileHost, path: deleteEntry.path, type },
      }, 40_000);
      if (response.isError) throw new Error(response.content?.[0]?.text ?? "删除失败");
      if (preview?.path === deleteEntry.path) setPreview(null);
      setDeleteEntry(null);
      await loadDirectory(fileHost, directory.path, false, true);
    } catch (nextError) {
      setError(userFacingError(nextError, "删除失败"));
    } finally {
      setLoading(false);
    }
  };

  const uploadFiles = async (files: FileList | File[]) => {
    if (!directory || !fileHost) return;
    const list = Array.from(files);
    let failed = false;
    for (const file of list) {
      let uploadId = "";
      try {
        setTransferLabel(`上传 ${file.name} · 0%`);
        const begin = await request<{ isError?: boolean; structuredContent?: { uploadId?: string; received?: number } }>("tools/call", { name: "sftp.uploadBegin", arguments: {} });
        uploadId = String(begin.structuredContent?.uploadId ?? "");
        if (!uploadId) throw new Error("无法创建上传会话");
        const chunkSize = 512 * 1024;
        for (let offset = 0; offset < file.size; offset += chunkSize) {
          const bytes = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + chunkSize)).arrayBuffer());
          const chunk = await request<{ isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: { received?: number } }>("tools/call", {
            name: "sftp.uploadChunk",
            arguments: { uploadId, dataBase64: bytesToBase64(bytes) },
          }, 30_000);
          if (chunk.isError) throw new Error(chunk.content?.[0]?.text ?? "上传分块失败");
          const received = Number(chunk.structuredContent?.received ?? offset + bytes.length);
          const percent = Math.min(100, Math.round((received / Math.max(1, file.size)) * 100));
          setTransferLabel(`上传 ${file.name} · ${percent}% · ${formatFileSize(received)} / ${formatFileSize(file.size)}`);
        }
        const remotePath = joinRemotePath(directory.path, file.name);
        setTransferLabel(`上传 ${file.name} · 正在写入远端…`);
        const commit = await request<{ isError?: boolean; content?: Array<{ text?: string }> }>("tools/call", {
          name: "sftp.uploadCommit",
          arguments: { host: fileHost, uploadId, path: remotePath },
        }, 10 * 60_000);
        if (commit.isError) throw new Error(commit.content?.[0]?.text ?? "上传提交失败");
        uploadId = "";
        setChangedPaths((current) => new Set([...current, remotePath]));
      } catch (nextError) {
        if (uploadId) void request("tools/call", { name: "sftp.uploadAbort", arguments: { uploadId } }).catch(() => {});
        setError(userFacingError(nextError, "上传失败"));
        failed = true;
        break;
      }
    }
    if (failed) {
      setTransferLabel(null);
    } else if (list.length > 0) {
      setTransferLabel(`已上传 ${list.length} 个文件`);
      window.setTimeout(() => setTransferLabel(null), 3500);
    }
    if (directory) await loadDirectory(fileHost, directory.path, false, true);
  };

  const downloadEntry = async (entry: SftpEntry) => {
    if (entry.type !== "file" && entry.type !== "symlink") return;
    let downloadId = "";
    try {
      setTransferLabel(`下载 ${entry.name} · 正在启动…`);
      const begin = await request<{ isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: SftpDownloadStatus }>("tools/call", {
        name: "sftp.downloadBegin",
        arguments: {
          host: fileHost,
          path: entry.path,
          ...(entry.type === "file" && Number.isFinite(entry.size) ? { expectedSize: entry.size } : {}),
        },
      }, 20_000);
      if (begin.isError || !begin.structuredContent?.downloadId) throw new Error(begin.content?.[0]?.text ?? "无法启动下载");
      downloadId = begin.structuredContent.downloadId;
      let status = begin.structuredContent;
      while (status.status === "running") {
        const total = status.total ?? (entry.type === "file" ? entry.size : null);
        const progress = total && total > 0
          ? `${Math.min(100, Math.round((status.received / total) * 100))}% · ${formatFileSize(status.received)} / ${formatFileSize(total)}`
          : formatFileSize(status.received);
        setTransferLabel(`下载 ${entry.name} · ${progress}`);
        await new Promise((resolve) => window.setTimeout(resolve, 350));
        const next = await requestReadOnly<{ isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: SftpDownloadStatus }>("tools/call", {
          name: "sftp.downloadStatus",
          arguments: { downloadId },
        }, 15_000);
        if (next.isError || !next.structuredContent) throw new Error(next.content?.[0]?.text ?? "读取下载状态失败");
        status = next.structuredContent;
      }
      if (status.status !== "completed") throw new Error(status.error ?? (status.status === "cancelled" ? "下载已取消" : "下载失败"));
      const localPath = status.localPath || "~/Downloads";
      setTransferLabel(`已下载 · ${localPath}`);
      window.setTimeout(() => setTransferLabel(null), 6000);
    } catch (nextError) {
      if (downloadId) {
        void request("tools/call", { name: "sftp.downloadCancel", arguments: { downloadId } }).catch(() => {});
      }
      setError(userFacingError(nextError, "下载失败"));
      setTransferLabel(null);
    }
  };

  const navigateToDraftPath = async () => {
    if (!fileHost || !directory || loading) return;
    const target = pathDraft.trim();
    if (!target) {
      setPathDraft(directory.path);
      return;
    }
    setAutoFollow(false);
    const nextDirectory = await loadDirectory(fileHost, target, false);
    if (nextDirectory) setPathDraft(nextDirectory.path);
  };

  const previewEntry = preview ? directory?.entries.find((entry) => entry.path === preview.path) ?? null : null;

  if (collapsed) {
    return (
      <aside className="sftp-sidebar is-collapsed" aria-label="SFTP 文件浏览器已收起">
        <Tooltip content="展开 SFTP">
          <IconButton
            size="1"
            variant="ghost"
            color="gray"
            className="sftp-expand-button"
            aria-label="展开 SFTP"
            onClick={() => onCollapsedChange(false)}
          >
            <DoubleArrowRightIcon />
          </IconButton>
        </Tooltip>
      </aside>
    );
  }

  return (
    <aside
      className={`sftp-sidebar ${dragActive ? "is-dragging" : ""}`}
      aria-label="SFTP 文件浏览器"
      onContextMenu={(event) => event.preventDefault()}
      onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDragActive(true); }}
      onDragLeave={(event) => { if (event.currentTarget === event.target) setDragActive(false); }}
      onDrop={(event) => { event.preventDefault(); setDragActive(false); if (event.dataTransfer.files.length) void uploadFiles(event.dataTransfer.files); }}
    >
      <div className="sftp-toolbar">
        <input ref={fileInputRef} type="file" multiple hidden onChange={(event) => { if (event.target.files?.length) void uploadFiles(event.target.files); event.currentTarget.value = ""; }} />
        <Tooltip content="收起 SFTP">
          <IconButton size="1" variant="ghost" color="gray" onClick={() => onCollapsedChange(true)} aria-label="收起 SFTP"><DoubleArrowLeftIcon /></IconButton>
        </Tooltip>
        <Select.Root value={fileHost || undefined} onValueChange={selectHost}>
          <Select.Trigger className="sftp-host-select" placeholder="选择主机" variant="surface" />
          <Select.Content>{hosts.filter((host) => host.resolved).map((host) => <Select.Item key={host.id} value={host.id}>{host.alias}</Select.Item>)}</Select.Content>
        </Select.Root>
        <Tooltip content={autoFollow ? "停止自动跟随 Agent" : "跟随当前远程上下文"}>
          <IconButton
            size="1"
            variant={autoFollow ? "soft" : "ghost"}
            color={autoFollow ? "green" : "gray"}
            disabled={!autoFollow && !contextHost}
            onClick={() => { if (autoFollow) setAutoFollow(false); else followContext(); }}
            aria-label={autoFollow ? "停止自动跟随 Agent" : "跟随当前远程上下文"}
          ><Link2Icon /></IconButton>
        </Tooltip>
        <Tooltip content="刷新目录">
          <IconButton size="1" variant="ghost" color="gray" disabled={!fileHost || loading} onClick={() => void loadDirectory(fileHost, directory?.path, false)} aria-label="刷新 SFTP 目录"><ReloadIcon /></IconButton>
        </Tooltip>
      </div>

      <div className="sftp-pathbar">
        <IconButton size="1" variant="ghost" color="gray" disabled={!directory || directory.path === "/" || loading} onClick={() => { setAutoFollow(false); void loadDirectory(fileHost, parentRemotePath(directory?.path ?? "/")); }} aria-label="上级目录"><ChevronLeftIcon /></IconButton>
        <TextField.Root
          className="sftp-path-input"
          size="1"
          value={pathDraft}
          disabled={!directory}
          aria-label="当前远端目录"
          placeholder="输入远端路径"
          onFocus={(event) => {
            setPathFocused(true);
            event.currentTarget.select();
          }}
          onBlur={() => {
            setPathFocused(false);
            setPathDraft(directory?.path ?? "");
          }}
          onChange={(event) => setPathDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void navigateToDraftPath();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setPathDraft(directory?.path ?? "");
              event.currentTarget.blur();
            }
          }}
        />
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            <IconButton size="1" variant="ghost" color="gray" disabled={!directory} className="sftp-path-menu" aria-label="当前目录操作" title="当前目录操作"><DotsHorizontalIcon /></IconButton>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content size="1" align="end">
            <DropdownMenu.Item onSelect={() => void copyRemotePath(directory?.path ?? "/")}><CopyIcon /> 复制路径</DropdownMenu.Item>
            <DropdownMenu.Separator />
            <DropdownMenu.Item onSelect={() => setNewFileOpen(true)}><FilePlusIcon /> 新建文件</DropdownMenu.Item>
            <DropdownMenu.Item onSelect={() => setMkdirOpen(true)}><ArchiveIcon /> 新建文件夹</DropdownMenu.Item>
            <DropdownMenu.Item onSelect={() => fileInputRef.current?.click()}><UploadIcon /> 上传文件</DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>

      <div className={`sftp-browser ${preview ? "has-preview" : ""}`}>
        <ScrollArea type="auto" scrollbars="vertical" className="sftp-list-scroll">
          <div className="sftp-list" aria-busy={loading}>
            {loading && !directory ? <div className="sftp-empty">正在读取目录…</div> : null}
            {!loading && error && !directory ? (
              <div className="sftp-empty error">
                <span>{error}</span>
                <Button size="1" variant="soft" color="gray" onClick={() => void loadDirectory(fileHost, pathDraft.trim() || undefined)}>重试</Button>
              </div>
            ) : null}
            {directory?.entries.map((entry) => (
              <div
                key={entry.path}
                ref={(node) => { if (node) entryRefs.current.set(entry.path, node); else entryRefs.current.delete(entry.path); }}
                className={`sftp-entry ${preview?.path === entry.path ? "is-selected" : ""} ${changedPaths.has(entry.path) ? "is-changed" : ""}`}
              >
                <button
                  type="button"
                  className="sftp-entry-main"
                  onClick={() => void openEntry(entry)}
                  onDoubleClick={() => { if (entry.type === "file") void editEntry(entry); }}
                  aria-label={`${entry.type === "directory" ? "打开目录" : "预览文件"} ${entry.name}`}
                >
                  <span className={`sftp-entry-icon ${entry.type}`} aria-hidden="true">
                    {entry.type === "directory" ? <ArchiveIcon /> : entry.type === "symlink" ? <Link2Icon /> : <FileIcon />}
                  </span>
                  <span className="sftp-entry-copy">
                    <strong title={entry.name}>{entry.name}</strong>
                    <span>{entry.type === "directory" ? "目录" : formatFileSize(entry.size)} · {entry.modified}</span>
                  </span>
                  {changedPaths.has(entry.path) ? <span className="sftp-change-dot" title="Agent 最近修改" /> : entry.type === "directory" ? <ChevronRightIcon className="sftp-entry-affordance" /> : <span />}
                </button>
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger>
                    <IconButton size="1" variant="ghost" color="gray" className="sftp-entry-menu" aria-label={`更多操作 ${entry.name}`} title="更多操作">
                      <DotsHorizontalIcon />
                    </IconButton>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Content size="1" align="end">
                    <DropdownMenu.Item onSelect={() => void openEntry(entry)}>{entry.type === "directory" ? "打开" : "预览"}</DropdownMenu.Item>
                    {entry.type === "file" && <DropdownMenu.Item onSelect={() => void editEntry(entry)}><Pencil2Icon /> 编辑文本</DropdownMenu.Item>}
                    {(entry.type === "file" || entry.type === "symlink") && <DropdownMenu.Item onSelect={() => void downloadEntry(entry)}><DownloadIcon /> 下载</DropdownMenu.Item>}
                    <DropdownMenu.Separator />
                    <DropdownMenu.Item onSelect={() => { setRenameEntry(entry); setRenameValue(entry.name); }}>重命名</DropdownMenu.Item>
                    <DropdownMenu.Item onSelect={() => void copyRemotePath(entry.path)}><CopyIcon /> 复制路径</DropdownMenu.Item>
                    <DropdownMenu.Separator />
                    <DropdownMenu.Item color="red" onSelect={() => setDeleteEntry(entry)}><TrashIcon /> 删除</DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Root>
              </div>
            ))}
            {!loading && directory && directory.entries.length === 0 ? <div className="sftp-empty">目录为空</div> : null}
          </div>
        </ScrollArea>

        {preview && (
          <section className="sftp-preview">
            <header>
              <div>
                <strong title={preview.path}>{preview.path.split("/").pop() || preview.path}</strong>
                <span>{formatFileSize(preview.size)}{preview.truncated ? " · 已截断" : ""}</span>
              </div>
              <Flex align="center" gap="1">
                {!preview.truncated && !editing && previewEntry?.type === "file" && <Button size="1" variant="ghost" color="gray" onClick={() => { setEditorText(preview.text); setEditing(true); }}><Pencil2Icon /> 编辑</Button>}
                {!editing && previewEntry && (previewEntry.type === "file" || previewEntry.type === "symlink") && <Button size="1" variant="ghost" color="gray" onClick={() => void downloadEntry(previewEntry)}><DownloadIcon /> 下载</Button>}
                {!editing && previewEntry && <Button size="1" variant="ghost" color="red" onClick={() => setDeleteEntry(previewEntry)}><TrashIcon /> 删除</Button>}
                <IconButton size="1" variant="ghost" color="gray" onClick={() => { setPreview(null); setEditing(false); }} aria-label="关闭文件预览"><Cross1Icon /></IconButton>
              </Flex>
            </header>
            {editing ? (
              <div className="sftp-editor">
                <textarea
                  value={editorText}
                  onChange={(event) => setEditorText(event.target.value)}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                      event.preventDefault();
                      if (!savingText) void saveText();
                    }
                  }}
                  spellCheck={false}
                  aria-label="远端文本编辑器"
                />
                <footer><span className="sftp-editor-hint">⌘/Ctrl + S 保存</span><Button size="1" variant="soft" color="gray" onClick={() => setEditing(false)}>取消</Button><Button size="1" loading={savingText} onClick={() => void saveText()}>保存</Button></footer>
              </div>
            ) : (
              <ScrollArea type="auto" scrollbars="both" className="sftp-preview-scroll"><pre>{previewLoading ? "正在读取文件…" : preview.text}</pre></ScrollArea>
            )}
          </section>
        )}
      </div>
      {error && directory && <div className="sftp-error-bar">{error}</div>}
      {transferLabel && <div className="sftp-transfer-bar">{transferLabel}</div>}
      {dragActive && <div className="sftp-drop-overlay"><UploadIcon /><strong>拖到这里上传</strong><span>{directory?.path ?? "远端目录"}</span></div>}

      <Dialog.Root open={newFileOpen} onOpenChange={setNewFileOpen}>
        <Dialog.Content maxWidth="360px"><Dialog.Title>新建文件</Dialog.Title><Dialog.Description size="2">将在 {directory?.path ?? "/"} 下创建空文件。</Dialog.Description><TextField.Root mt="3" autoFocus value={newFileValue} onChange={(event) => setNewFileValue(event.target.value)} placeholder="文件名称，例如 notes.txt" /><Flex justify="end" gap="2" mt="4"><Dialog.Close><Button variant="soft" color="gray">取消</Button></Dialog.Close><Button onClick={() => void createFile()} disabled={!newFileValue.trim()}>创建</Button></Flex></Dialog.Content>
      </Dialog.Root>

      <Dialog.Root open={mkdirOpen} onOpenChange={setMkdirOpen}>
        <Dialog.Content maxWidth="360px"><Dialog.Title>新建文件夹</Dialog.Title><Dialog.Description size="2">将在 {directory?.path ?? "/"} 下创建。</Dialog.Description><TextField.Root mt="3" autoFocus value={mkdirValue} onChange={(event) => setMkdirValue(event.target.value)} placeholder="文件夹名称" /><Flex justify="end" gap="2" mt="4"><Dialog.Close><Button variant="soft" color="gray">取消</Button></Dialog.Close><Button onClick={() => void createDirectory()} disabled={!mkdirValue.trim()}>创建</Button></Flex></Dialog.Content>
      </Dialog.Root>

      <Dialog.Root open={Boolean(renameEntry)} onOpenChange={(open) => { if (!open) setRenameEntry(null); }}>
        <Dialog.Content maxWidth="360px"><Dialog.Title>重命名</Dialog.Title><Dialog.Description size="2">{renameEntry?.path}</Dialog.Description><TextField.Root mt="3" autoFocus value={renameValue} onChange={(event) => setRenameValue(event.target.value)} /><Flex justify="end" gap="2" mt="4"><Dialog.Close><Button variant="soft" color="gray">取消</Button></Dialog.Close><Button onClick={() => void renameRemote()} disabled={!renameValue.trim()}>重命名</Button></Flex></Dialog.Content>
      </Dialog.Root>

      <AlertDialog.Root open={Boolean(deleteEntry)} onOpenChange={(open) => { if (!open) setDeleteEntry(null); }}>
        <AlertDialog.Content maxWidth="390px">
          <AlertDialog.Title>删除 {deleteEntry?.name}？</AlertDialog.Title>
          <AlertDialog.Description size="2">{deleteEntry?.type === "directory" ? "只允许删除空目录，不会递归删除目录内容。" : "该操作会直接删除远端文件，无法从插件内撤销。"}</AlertDialog.Description>
          <Flex justify="end" gap="2" mt="4"><AlertDialog.Cancel><Button variant="soft" color="gray">取消</Button></AlertDialog.Cancel><AlertDialog.Action><Button color="red" onClick={() => void removeRemote()}>删除</Button></AlertDialog.Action></Flex>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </aside>
  );
}

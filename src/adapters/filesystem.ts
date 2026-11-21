import fs from 'node:fs';
import path from 'node:path';
import { createUnifiedTextDiff } from '../core/diff.js';
import type { ToolDefinition } from '../types.js';

interface FileSnapshot {
  relativePath: string;
  existed: boolean;
  content: string | null;
}

export function resolveSandboxPath(
  sandboxDir: string,
  targetPath: string,
): { root: string; absPath: string; relativePath: string } {
  if (!targetPath || typeof targetPath !== 'string') {
    throw new Error('File path must be a non-empty string.');
  }
  const root = path.resolve(sandboxDir);
  fs.mkdirSync(root, { recursive: true });
  const sanitized = targetPath.replace(/^\/+/, '');
  const absPath = path.resolve(root, sanitized);
  const rel = path.relative(root, absPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path "${targetPath}" escapes the sandbox directory.`);
  }
  return { root, absPath, relativePath: rel || '.' };
}

export function createFilesystemTools(
  sandboxDir: string,
): Array<ToolDefinition<Record<string, unknown>, unknown>> {
  const listDir: ToolDefinition<
    { path?: string },
    Array<{ name: string; type: 'file' | 'dir'; sizeBytes: number }>
  > = {
    name: 'fs.list_dir',
    description: 'List files and folders inside the local sandbox directory.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
    },
    previewDiff: (args) => ({
      title: `List directory ${args.path ?? '.'}`,
      operation: 'read',
      target: `fs://${args.path ?? '.'}`,
      before: null,
      after: null,
      unifiedDiff: `--- fs://${args.path ?? '.'} (read-only query)`,
      reversible: true,
      reversibilityNote: 'Read-only operation; no state is mutated.',
    }),
    execute: (args) => {
      const { absPath } = resolveSandboxPath(sandboxDir, args.path ?? '.');
      if (!fs.existsSync(absPath)) {
        return [];
      }
      const entries = fs.readdirSync(absPath, { withFileTypes: true });
      return entries
        .map((entry) => {
          const full = path.join(absPath, entry.name);
          const stat = fs.statSync(full);
          return {
            name: entry.name,
            type: entry.isDirectory() ? ('dir' as const) : ('file' as const),
            sizeBytes: entry.isDirectory() ? 0 : stat.size,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  };

  const readFile: ToolDefinition<
    { path: string },
    { path: string; content: string; sizeBytes: number }
  > = {
    name: 'fs.read_file',
    description: 'Read a file inside the local sandbox directory.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
    },
    previewDiff: (args) => ({
      title: `Read file ${args.path}`,
      operation: 'read',
      target: `fs://${args.path}`,
      before: null,
      after: null,
      unifiedDiff: `--- fs://${args.path} (read-only query)`,
      reversible: true,
      reversibilityNote: 'Read-only operation; no state is mutated.',
    }),
    execute: (args) => {
      const { absPath, relativePath } = resolveSandboxPath(
        sandboxDir,
        args.path,
      );
      if (!fs.existsSync(absPath)) {
        throw new Error(`File "${relativePath}" does not exist.`);
      }
      const content = fs.readFileSync(absPath, 'utf8');
      return {
        path: relativePath,
        content,
        sizeBytes: Buffer.byteLength(content, 'utf8'),
      };
    },
  };

  const writeFile: ToolDefinition<
    { path: string; content: string },
    { path: string; bytesWritten: number; created: boolean }
  > = {
    name: 'fs.write_file',
    description:
      'Write or overwrite a file in the local sandbox, capturing a pre-write snapshot for rollback.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
    captureSnapshot: (args): FileSnapshot => {
      const { absPath, relativePath } = resolveSandboxPath(
        sandboxDir,
        args.path,
      );
      if (!fs.existsSync(absPath)) {
        return { relativePath, existed: false, content: null };
      }
      return {
        relativePath,
        existed: true,
        content: fs.readFileSync(absPath, 'utf8'),
      };
    },
    previewDiff: (args) => {
      const { absPath, relativePath } = resolveSandboxPath(
        sandboxDir,
        args.path,
      );
      const existed = fs.existsSync(absPath);
      const beforeContent = existed ? fs.readFileSync(absPath, 'utf8') : null;

      return {
        title: `${existed ? 'Modify' : 'Create'} file ${relativePath}`,
        operation: existed ? 'update' : 'create',
        target: `fs://${relativePath}`,
        before: beforeContent,
        after: args.content,
        unifiedDiff: createUnifiedTextDiff(
          relativePath,
          beforeContent,
          args.content,
        ),
        reversible: true,
        reversibilityNote: existed
          ? 'Reversible via byte-for-byte restore of pre-write file snapshot.'
          : 'Reversible by deleting the newly created file.',
      };
    },
    execute: (args) => {
      const { absPath, relativePath } = resolveSandboxPath(
        sandboxDir,
        args.path,
      );
      const existed = fs.existsSync(absPath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, args.content, 'utf8');
      return {
        path: relativePath,
        bytesWritten: Buffer.byteLength(args.content, 'utf8'),
        created: !existed,
      };
    },
    compensate: ({ args, beforeSnapshot }) => {
      const snap = beforeSnapshot as FileSnapshot | null;
      const targetPath = snap?.relativePath ?? args.path;
      const { absPath, relativePath } = resolveSandboxPath(
        sandboxDir,
        targetPath,
      );

      if (snap?.existed && snap.content !== null) {
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, snap.content, 'utf8');
        return {
          path: relativePath,
          action: 'restored_previous_content',
        };
      }

      fs.rmSync(absPath, { force: true });
      return {
        path: relativePath,
        action: 'removed_created_file',
      };
    },
  };

  const deleteFile: ToolDefinition<
    { path: string },
    { path: string; deleted: boolean }
  > = {
    name: 'fs.delete_file',
    description:
      'Delete a file inside the local sandbox, preserving its contents in the snapshot store.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
    },
    captureSnapshot: (args): FileSnapshot => {
      const { absPath, relativePath } = resolveSandboxPath(
        sandboxDir,
        args.path,
      );
      if (!fs.existsSync(absPath)) {
        return { relativePath, existed: false, content: null };
      }
      return {
        relativePath,
        existed: true,
        content: fs.readFileSync(absPath, 'utf8'),
      };
    },
    previewDiff: (args) => {
      const { absPath, relativePath } = resolveSandboxPath(
        sandboxDir,
        args.path,
      );
      const existed = fs.existsSync(absPath);
      const beforeContent = existed ? fs.readFileSync(absPath, 'utf8') : null;

      return {
        title: `Delete file ${relativePath}`,
        operation: 'delete',
        target: `fs://${relativePath}`,
        before: beforeContent,
        after: null,
        unifiedDiff: createUnifiedTextDiff(relativePath, beforeContent, null),
        reversible: true,
        reversibilityNote:
          'Reversible via restoring deleted file contents from snapshot.',
      };
    },
    execute: (args) => {
      const { absPath, relativePath } = resolveSandboxPath(
        sandboxDir,
        args.path,
      );
      if (!fs.existsSync(absPath)) {
        throw new Error(`File "${relativePath}" does not exist.`);
      }
      fs.rmSync(absPath);
      return { path: relativePath, deleted: true };
    },
    compensate: ({ beforeSnapshot }) => {
      const snap = beforeSnapshot as FileSnapshot | null;
      if (!snap?.existed || snap.content === null) {
        throw new Error('Cannot restore deleted file without snapshot.');
      }
      const { absPath, relativePath } = resolveSandboxPath(
        sandboxDir,
        snap.relativePath,
      );
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, snap.content, 'utf8');
      return {
        path: relativePath,
        action: 'recreated_deleted_file',
      };
    },
  };

  return [
    listDir as unknown as ToolDefinition<Record<string, unknown>, unknown>,
    readFile as unknown as ToolDefinition<Record<string, unknown>, unknown>,
    writeFile as unknown as ToolDefinition<Record<string, unknown>, unknown>,
    deleteFile as unknown as ToolDefinition<Record<string, unknown>, unknown>,
  ];
}

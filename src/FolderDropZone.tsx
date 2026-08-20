import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FileUp, FolderPlus } from 'lucide-react';
import { isLocalWeb, isTauri } from './lib/env';

type DroppedFile = File & { path?: string };
type FileSystemDataTransferItem = DataTransferItem & {
  getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>;
  webkitGetAsEntry?: () => { isDirectory?: boolean; isFile?: boolean } | null;
};

type DropPathKind = 'folder' | 'file';

interface PathTransferResult {
  paths: string[];
  names: string[];
  matchingItemWithoutPath: boolean;
}

export const isPhysicalPositionInside = (
  position: { x: number; y: number },
  rect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>,
  devicePixelRatio = 1,
): boolean => {
  const scale = devicePixelRatio > 0 ? devicePixelRatio : 1;
  const x = position.x / scale;
  const y = position.y / scale;
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
};

export const shouldUseBrowserDropFallback = (tauriRuntime: boolean): boolean =>
  !tauriRuntime;

export const pathlessDropMessage = (pathKind: DropPathKind): string => {
  const label = pathKind === 'folder' ? '폴더' : '파일';
  return `브라우저가 ${label}의 실제 경로를 제공하지 않았습니다. 오른쪽 선택 버튼을 사용해주세요.`;
};

interface Props {
  onFolderPath: (path: string) => void | Promise<void>;
  onChoose?: () => void | Promise<void>;
  onError?: (message: string) => void;
  value?: string;
  onValueChange?: (value: string) => void;
  onInputKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  placeholder?: string;
  prefixLabel?: string;
  label?: string;
  hint?: string;
  compact?: boolean;
  testId?: string;
  pathKind?: DropPathKind;
}

export const normalizeFileUri = (value: string): string | null => {
  const candidate = value
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line && !line.startsWith('#'));
  if (!candidate) return null;

  if (/^file:\/\//i.test(candidate)) {
    try {
      let pathname = decodeURIComponent(new URL(candidate).pathname);
      if (/^\/[A-Za-z]:\//.test(pathname)) pathname = pathname.slice(1);
      return pathname;
    } catch {
      return null;
    }
  }
  return /^(\/|[A-Za-z]:[\\/])/.test(candidate) ? candidate : null;
};

const pathsFromTransfer = async (
  transfer: DataTransfer,
  pathKind: DropPathKind,
): Promise<PathTransferResult> => {
  const names = Array.from(transfer.files ?? [])
    .map(file => file.name?.trim())
    .filter((name): name is string => !!name);
  const directPaths = Array.from(transfer.files ?? [])
    .map(file => (file as DroppedFile).path?.trim())
    .filter((path): path is string => !!path);
  if (directPaths.length > 0) return { paths: directPaths, names, matchingItemWithoutPath: false };

  for (const mime of ['text/uri-list', 'text/plain']) {
    const path = normalizeFileUri(transfer.getData(mime));
    if (path) return { paths: [path], names, matchingItemWithoutPath: false };
  }

  for (const item of Array.from(transfer.items ?? []) as FileSystemDataTransferItem[]) {
    try {
      const entry = item.webkitGetAsEntry?.();
      const matchingEntry = pathKind === 'folder' ? entry?.isDirectory : entry?.isFile;
      if (matchingEntry) {
        return { paths: [], names, matchingItemWithoutPath: true };
      }
      const handle = await item.getAsFileSystemHandle?.();
      if (handle?.kind === pathKind) {
        return { paths: [], names, matchingItemWithoutPath: true };
      }
    } catch {
      // Browser security policies can reject handle access. Fall through to
      // the ordinary invalid-drop message unless a matching item was identified.
    }
  }
  return { paths: [], names, matchingItemWithoutPath: false };
};

export function FolderDropZone({
  onFolderPath,
  onChoose,
  onError,
  value,
  onValueChange,
  onInputKeyDown,
  placeholder,
  prefixLabel,
  label = '폴더를 여기로 드래그',
  hint = '또는 클릭해서 폴더 선택',
  compact = false,
  testId,
  pathKind = 'folder',
}: Props) {
  const zoneRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const inlineInput = typeof onValueChange === 'function';

  const acceptPaths = useCallback(async (paths: string[]) => {
    const firstPath = paths.find(Boolean);
    if (!firstPath || busy) {
      if (!firstPath) {
        const label = pathKind === 'folder' ? '폴더' : '파일';
        onError?.(`${label}의 실제 경로를 확인하지 못했습니다. 클릭해서 ${label}을 선택해주세요.`);
      }
      return;
    }
    setBusy(true);
    try {
      await onFolderPath(firstPath);
    } catch (error: any) {
      onError?.(error?.message || String(error));
    } finally {
      setBusy(false);
      setDragging(false);
    }
  }, [busy, onError, onFolderPath, pathKind]);

  const containsPhysicalPosition = useCallback((position: { x: number; y: number }) => {
    const rect = zoneRef.current?.getBoundingClientRect();
    if (!rect) return false;
    return isPhysicalPositionInside(position, rect, window.devicePixelRatio || 1);
  }, []);

  const resolvePathlessLocalDrop = useCallback(async (names: string[]) => {
    if (!isLocalWeb() || names.length === 0) {
      onError?.(pathlessDropMessage(pathKind));
      return;
    }
    try {
      const response = await fetch('/api/resolve-dropped-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pathKind, names }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.path) {
        throw new Error(result.error || pathlessDropMessage(pathKind));
      }
      await acceptPaths([result.path]);
    } catch (error: any) {
      onError?.(error?.message || pathlessDropMessage(pathKind));
    }
  }, [acceptPaths, onError, pathKind]);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import('@tauri-apps/api/webview')
      .then(({ getCurrentWebview }) => getCurrentWebview().onDragDropEvent(({ payload }) => {
        if (payload.type === 'leave') {
          setDragging(false);
          return;
        }
        const inside = containsPhysicalPosition(payload.position);
        setDragging(inside);
        if (payload.type === 'drop' && inside) void acceptPaths(payload.paths);
      }))
      .then(stop => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(error => onError?.(`Tauri 드롭 준비 실패: ${error?.message || String(error)}`));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [acceptPaths, containsPhysicalPosition, onError]);

  const choose = useCallback(async () => {
    if (busy || !onChoose) return;
    setBusy(true);
    try {
      await onChoose();
    } catch (error: any) {
      onError?.(error?.message || String(error));
    } finally {
      setBusy(false);
      setDragging(false);
    }
  }, [busy, onChoose, onError]);

  return (
    <div
      ref={zoneRef}
      data-testid={testId}
      role={!inlineInput && onChoose ? 'button' : undefined}
      tabIndex={!inlineInput && onChoose ? 0 : undefined}
      aria-label={`${label}. ${hint}`}
      onClick={() => {
        if (!inlineInput) void choose();
      }}
      onKeyDown={event => {
        if (!inlineInput && onChoose && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          void choose();
        }
      }}
      onDragEnter={event => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragOver={event => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setDragging(true);
      }}
      onDragLeave={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={event => {
        event.preventDefault();
        setDragging(false);
        // Tauri delivers the absolute path through onDragDropEvent above. WebKit also
        // emits a native drop event, but strips the path from its File object. Treating
        // that pathless duplicate as a browser drop opened the file picker after a
        // successful drag, so desktop drops must be handled by the Tauri event only.
        if (!shouldUseBrowserDropFallback(isTauri())) return;
        void pathsFromTransfer(event.dataTransfer, pathKind)
          .then(result => {
            if (result.paths.length > 0) return acceptPaths(result.paths);
            // Browsers commonly expose a dropped File without its absolute local path.
            // Opening the picker automatically here makes a drag look like a click and
            // surprises the user. Local macOS web mode can recover the matching path
            // from the native drag pasteboard without opening a dialog.
            if (result.matchingItemWithoutPath) {
              return resolvePathlessLocalDrop(result.names);
            }
            return acceptPaths([]);
          })
          .catch(error => onError?.(error?.message || String(error)));
      }}
      className={[
        'w-full rounded-lg border transition-colors select-none',
        inlineInput
          ? 'flex min-h-9 items-stretch overflow-hidden'
          : `border-dashed ${compact ? 'px-3 py-2' : 'px-4 py-5'}`,
        dragging
          ? 'border-teal-300 bg-teal-400/15 text-teal-100'
          : 'border-stone-700 bg-stone-900/55 text-zinc-400',
        !inlineInput && onChoose ? 'cursor-pointer hover:border-teal-500/50 hover:bg-teal-500/5' : '',
        busy ? 'opacity-60 cursor-wait' : '',
      ].join(' ')}
    >
      {inlineInput ? (
        <>
          {prefixLabel && (
            <span className="flex w-24 flex-none items-center border-r border-stone-700 bg-black/20 px-3 text-[10px] font-medium text-zinc-500">
              {prefixLabel}
            </span>
          )}
          <input
            type="text"
            value={value ?? ''}
            onChange={event => onValueChange?.(event.target.value)}
            onClick={event => event.stopPropagation()}
            onKeyDown={onInputKeyDown}
            placeholder={dragging ? label : placeholder}
            aria-label={placeholder || label}
            className="min-w-0 flex-1 bg-transparent px-3 py-2 text-xs text-zinc-100 outline-none placeholder:text-zinc-600"
          />
          <button
            type="button"
            onClick={event => {
              event.stopPropagation();
              void choose();
            }}
            disabled={busy || !onChoose}
            title={`${label} · ${hint}`}
            aria-label={`${label} · ${hint}`}
            className="flex w-10 flex-none items-center justify-center border-l border-stone-700 bg-white/[0.03] text-zinc-400 transition-colors hover:bg-teal-500/10 hover:text-teal-300 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pathKind === 'folder'
              ? <FolderPlus className="h-4 w-4" />
              : <FileUp className="h-4 w-4" />}
          </button>
        </>
      ) : (
        <div className={`flex items-center justify-center ${compact ? 'gap-2' : 'flex-col gap-2'}`}>
          {pathKind === 'folder'
            ? <FolderPlus className={compact ? 'w-4 h-4 text-teal-300' : 'w-5 h-5 text-teal-300'} />
            : <FileUp className={compact ? 'w-4 h-4 text-teal-300' : 'w-5 h-5 text-teal-300'} />}
          <div className={compact ? 'flex min-w-0 items-center gap-1.5 text-[11px]' : 'text-center'}>
            <span className={compact ? 'truncate text-zinc-300' : 'block text-xs font-medium text-zinc-200'}>
              {busy ? `${pathKind === 'folder' ? '폴더' : '파일'} 확인 중…` : label}
            </span>
            {!busy && <span className={compact ? 'text-zinc-600' : 'mt-1 block text-[10px] text-zinc-500'}>{hint}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

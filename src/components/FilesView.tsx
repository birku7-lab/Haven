import {
  Archive,
  Check,
  ChevronRight,
  Code2,
  Copy,
  Download,
  ExternalLink,
  File as FileIcon,
  FileText,
  Folder,
  FolderInput,
  FolderPlus,
  Grid,
  Image as ImageIcon,
  Info,
  List,
  Music,
  Pencil,
  Search,
  Star,
  Terminal,
  Trash2,
  Upload,
  Video,
  X,
} from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { api, buildContentUrl, buildThumbnailUrl } from '../lib/api';
import { formatBytes, formatDate } from '../lib/format';
import type { FileCategory, FileRecord, FolderRecord } from '../types';

interface FilesViewProps {
  initialFolderId?: string | null;
  onUploadFiles: (files: FileList | File[], folderId: string | null) => void;
  refreshTrigger: number;
}

const CATEGORIES: Array<{ id: FileCategory | 'all'; label: string }> = [
  { id: 'all', label: 'All Types' },
  { id: 'photo', label: 'Photos' },
  { id: 'video', label: 'Videos' },
  { id: 'document', label: 'Documents' },
  { id: 'audio', label: 'Audio' },
  { id: 'archive', label: 'Archives' },
  { id: 'code', label: 'Code' },
  { id: 'executable', label: 'Executables' },
  { id: 'other', label: 'Other' },
];

export function FilesView({ initialFolderId = null, onUploadFiles, refreshTrigger }: FilesViewProps) {
  const [folderId, setFolderId] = useState<string | null>(initialFolderId);
  const [folders, setFolders] = useState<FolderRecord[]>([]);
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [allFolders, setAllFolders] = useState<FolderRecord[]>([]);
  const [breadcrumbs, setBreadcrumbs] = useState<Array<{ id: string | null; name: string }>>([
    { id: null, name: 'HavenStorage' },
  ]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<FileCategory | 'all'>('all');
  const [quickFilter, setQuickFilter] = useState<'none' | 'favorites' | 'recent'>('none');
  const [sortBy, setSortBy] = useState<'name' | 'size' | 'modifiedAt' | 'importedAt'>('modifiedAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [dragOver, setDragOver] = useState(false);

  // Modals / Drawers
  const [newFolderModal, setNewFolderModal] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [renameTarget, setRenameTarget] = useState<{ type: 'file' | 'folder'; id: string; name: string } | null>(null);
  const [moveFileTarget, setMoveFileTarget] = useState<FileRecord | null>(null);
  const [moveDestFolderId, setMoveDestFolderId] = useState<string>('');
  const [previewFile, setPreviewFile] = useState<FileRecord | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [propertiesData, setPropertiesData] = useState<{ file: FileRecord; absolutePath: string } | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setFolderId(initialFolderId);
  }, [initialFolderId]);

  const loadFiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listFiles({
        folderId,
        search: search || undefined,
        category,
        favorites: quickFilter === 'favorites',
        recent: quickFilter === 'recent',
        sortBy,
        sortDir,
      });
      setFolders(res.folders);
      setFiles(res.files);
      setBreadcrumbs(res.breadcrumbs);
      setAllFolders(res.allFolders);
      setSelectedIds(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load files');
    } finally {
      setLoading(false);
    }
  }, [folderId, search, category, quickFilter, sortBy, sortDir]);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles, refreshTrigger]);

  const showToast = (msg: string) => {
    setStatusMessage(msg);
    setTimeout(() => setStatusMessage((cur) => (cur === msg ? null : cur)), 3500);
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === files.length && files.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(files.map((f) => f.id)));
    }
  };

  const handleCreateFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFolderName.trim()) return;
    try {
      await api.createFolder(newFolderName.trim(), folderId);
      setNewFolderName('');
      setNewFolderModal(false);
      await loadFiles();
      showToast('Folder created');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create folder');
    }
  };

  const handleRenameSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!renameTarget || !renameTarget.name.trim()) return;
    try {
      if (renameTarget.type === 'file') {
        await api.updateFile(renameTarget.id, { name: renameTarget.name.trim() });
      } else {
        await api.renameFolder(renameTarget.id, renameTarget.name.trim());
      }
      setRenameTarget(null);
      await loadFiles();
      showToast('Renamed successfully');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rename failed');
    }
  };

  const handleMoveSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!moveFileTarget || !moveDestFolderId) return;
    try {
      await api.moveFile(moveFileTarget.id, moveDestFolderId);
      setMoveFileTarget(null);
      await loadFiles();
      showToast('File moved');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Move failed');
    }
  };

  const handleCopy = async (file: FileRecord) => {
    try {
      await api.copyFile(file.id, file.folderId);
      await loadFiles();
      showToast(`Created copy of ${file.name}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Copy failed');
    }
  };

  const handleDeleteFile = async (file: FileRecord) => {
    try {
      await api.deleteFile(file.id);
      await loadFiles();
      showToast(`Moved ${file.name} to Recycle Bin`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) return;
    try {
      const res = await api.batchDeleteFiles(Array.from(selectedIds));
      await loadFiles();
      showToast(`Moved ${res.movedToRecycleBin} file(s) to Recycle Bin`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Batch delete failed');
    }
  };

  const handleDeleteFolder = async (folder: FolderRecord) => {
    try {
      const res = await api.deleteFolder(folder.id);
      await loadFiles();
      showToast(`Folder removed (${res.filesMovedToBin} file(s) moved to Recycle Bin)`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete folder');
    }
  };

  const handleToggleFavorite = async (file: FileRecord) => {
    try {
      await api.updateFile(file.id, { isFavorite: !file.isFavorite });
      await loadFiles();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update favorite');
    }
  };

  const handleOpenPreview = async (file: FileRecord) => {
    setPreviewFile(file);
    setPreviewText(null);
    if (
      file.category === 'code' ||
      file.mimeType.startsWith('text/') ||
      ['.txt', '.md', '.json', '.csv', '.xml', '.yaml', '.yml', '.log'].includes(file.extension)
    ) {
      try {
        const res = await fetch(buildContentUrl(file.id));
        const txt = await res.text();
        setPreviewText(txt.slice(0, 64 * 1024));
      } catch {
        setPreviewText('Unable to load text preview.');
      }
    }
  };

  const handleShowProperties = async (file: FileRecord) => {
    try {
      const details = await api.getFileDetails(file.id);
      setPropertiesData(details);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load properties');
    }
  };

  const handleCopyPath = async (file: FileRecord) => {
    try {
      const details = await api.getFileDetails(file.id);
      await navigator.clipboard.writeText(details.absolutePath);
      showToast('File path copied to clipboard');
    } catch {
      showToast(file.relativePath);
    }
  };

  const handleOpenInOs = async (file: FileRecord) => {
    try {
      const res = await api.openFileInOs(file.id);
      showToast(res.opened ? `Opened ${file.name} in default application` : res.message || res.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Open failed');
    }
  };

  const renderCategoryIcon = (cat: FileCategory) => {
    switch (cat) {
      case 'photo':
        return <ImageIcon className="w-4 h-4 text-sky-400" />;
      case 'video':
        return <Video className="w-4 h-4 text-indigo-400" />;
      case 'audio':
        return <Music className="w-4 h-4 text-emerald-400" />;
      case 'document':
        return <FileText className="w-4 h-4 text-amber-400" />;
      case 'archive':
        return <Archive className="w-4 h-4 text-orange-400" />;
      case 'code':
        return <Code2 className="w-4 h-4 text-cyan-400" />;
      case 'executable':
        return <Terminal className="w-4 h-4 text-rose-400" />;
      default:
        return <FileIcon className="w-4 h-4 text-zinc-400" />;
    }
  };

  return (
    <div
      className={`h-full flex flex-col ${dragOver ? 'ring-2 ring-inset ring-blue-500 bg-blue-500/5' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          onUploadFiles(e.dataTransfer.files, folderId);
        }
      }}
    >
      {/* Toolbar */}
      <div className="px-6 py-4 border-b border-zinc-200 dark:border-white/[0.08] bg-white dark:bg-[#1F1F23] flex flex-wrap items-center justify-between gap-3">
        {/* Breadcrumbs */}
        <div className="flex items-center gap-1 text-sm overflow-x-auto">
          {breadcrumbs.map((b, idx) => (
            <React.Fragment key={b.id ?? 'root'}>
              {idx > 0 && <ChevronRight className="w-3.5 h-3.5 text-zinc-400 shrink-0" />}
              <button
                type="button"
                onClick={() => {
                  setSearch('');
                  setQuickFilter('none');
                  setCategory('all');
                  setFolderId(b.id);
                }}
                className={`px-2 py-1 rounded-md text-xs font-medium whitespace-nowrap cursor-pointer ${
                  idx === breadcrumbs.length - 1
                    ? 'text-zinc-900 dark:text-zinc-100 bg-zinc-100 dark:bg-white/[0.08]'
                    : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200'
                }`}
              >
                {b.name}
              </button>
            </React.Fragment>
          ))}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search files..."
              className="pl-8 pr-3 py-1.5 w-48 text-xs rounded-lg bg-zinc-100 dark:bg-[#18181B] border border-zinc-200 dark:border-white/[0.08] focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            />
          </div>

          <button
            type="button"
            onClick={() => setNewFolderModal(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-100 dark:bg-white/[0.06] hover:bg-zinc-200 dark:hover:bg-white/[0.1] border border-zinc-200 dark:border-white/[0.08] cursor-pointer whitespace-nowrap"
          >
            <FolderPlus className="w-3.5 h-3.5" />
            New Folder
          </button>

          <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white cursor-pointer whitespace-nowrap">
            <Upload className="w-3.5 h-3.5" />
            Import Files
            <input
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) {
                  onUploadFiles(e.target.files, folderId);
                  e.target.value = '';
                }
              }}
            />
          </label>
        </div>
      </div>

      {/* Filter & View Controls */}
      <div className="px-6 py-2.5 border-b border-zinc-200 dark:border-white/[0.08] flex flex-wrap items-center justify-between gap-3 bg-zinc-50 dark:bg-[#18181B]">
        <div className="flex items-center gap-1.5 overflow-x-auto">
          <button
            type="button"
            onClick={() => setQuickFilter(quickFilter === 'favorites' ? 'none' : 'favorites')}
            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium cursor-pointer whitespace-nowrap ${
              quickFilter === 'favorites'
                ? 'bg-amber-500/15 text-amber-600 dark:text-amber-300'
                : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/60 dark:hover:bg-white/[0.06]'
            }`}
          >
            <Star className="w-3 h-3" />
            Favorites
          </button>
          <button
            type="button"
            onClick={() => setQuickFilter(quickFilter === 'recent' ? 'none' : 'recent')}
            className={`px-2.5 py-1 rounded-md text-xs font-medium cursor-pointer whitespace-nowrap ${
              quickFilter === 'recent'
                ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400'
                : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/60 dark:hover:bg-white/[0.06]'
            }`}
          >
            Recent
          </button>
          <span className="text-zinc-300 dark:text-white/10 mx-1">|</span>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as FileCategory | 'all')}
            aria-label="Filter by file type"
            className="text-xs px-2.5 py-1 rounded-md bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.08]"
          >
            {CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          {selectedIds.size > 0 && (
            <button
              type="button"
              onClick={() => void handleBatchDelete()}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-red-500/15 text-red-600 dark:text-red-400 hover:bg-red-500/25 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete Selected ({selectedIds.size})
            </button>
          )}

          <select
            value={`${sortBy}:${sortDir}`}
            onChange={(e) => {
              const [col, dir] = e.target.value.split(':') as [typeof sortBy, typeof sortDir];
              setSortBy(col);
              setSortDir(dir);
            }}
            aria-label="Sort files"
            className="text-xs px-2.5 py-1 rounded-md bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.08]"
          >
            <option value="modifiedAt:desc">Modified (Newest)</option>
            <option value="modifiedAt:asc">Modified (Oldest)</option>
            <option value="name:asc">Name (A–Z)</option>
            <option value="name:desc">Name (Z–A)</option>
            <option value="size:desc">Size (Largest)</option>
            <option value="size:asc">Size (Smallest)</option>
          </select>

          <div className="flex items-center bg-zinc-200/70 dark:bg-[#1F1F23] p-0.5 rounded-md border border-zinc-200 dark:border-white/[0.08]">
            <button
              type="button"
              onClick={() => setViewMode('list')}
              aria-label="List view"
              className={`p-1 rounded cursor-pointer ${viewMode === 'list' ? 'bg-white dark:bg-white/10 shadow-xs' : 'text-zinc-500'}`}
            >
              <List className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setViewMode('grid')}
              aria-label="Grid view"
              className={`p-1 rounded cursor-pointer ${viewMode === 'grid' ? 'bg-white dark:bg-white/10 shadow-xs' : 'text-zinc-500'}`}
            >
              <Grid className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {statusMessage && (
        <div className="mx-6 mt-3 px-3.5 py-2 rounded-lg text-xs bg-blue-500/10 border border-blue-500/20 text-blue-600 dark:text-blue-300">
          {statusMessage}
        </div>
      )}
      {error && (
        <div className="mx-6 mt-3 px-3.5 py-2 rounded-lg text-xs bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 flex items-center justify-between">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} className="cursor-pointer">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-11 rounded-lg bg-zinc-200/60 dark:bg-white/[0.04] animate-pulse" />
            ))}
          </div>
        ) : folders.length === 0 && files.length === 0 ? (
          <div className="py-20 text-center border border-dashed border-zinc-300 dark:border-white/[0.12] rounded-xl">
            <Folder className="w-8 h-8 text-zinc-400 mx-auto mb-3" />
            <div className="text-sm font-medium">This folder is empty</div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 mb-4">
              Drag and drop files anywhere here, or import files from your computer.
            </p>
            <label className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white cursor-pointer">
              <Upload className="w-3.5 h-3.5" />
              Import Files
              <input
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) {
                    onUploadFiles(e.target.files, folderId);
                    e.target.value = '';
                  }
                }}
              />
            </label>
          </div>
        ) : viewMode === 'list' ? (
          <div className="bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.08] rounded-xl overflow-hidden">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-white/[0.08] text-xs text-zinc-500 dark:text-zinc-400">
                  <th className="py-2.5 pl-4 pr-2 w-8">
                    <input
                      type="checkbox"
                      checked={files.length > 0 && selectedIds.size === files.length}
                      onChange={toggleSelectAll}
                      aria-label="Select all files"
                    />
                  </th>
                  <th className="py-2.5 px-3 font-medium">Name</th>
                  <th className="py-2.5 px-3 font-medium">Type</th>
                  <th className="py-2.5 px-3 font-medium text-right">Size</th>
                  <th className="py-2.5 px-3 font-medium">Modified</th>
                  <th className="py-2.5 pr-4 pl-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-white/[0.05] text-sm">
                {folders.map((fld) => (
                  <tr
                    key={fld.id}
                    className="hover:bg-zinc-50 dark:hover:bg-white/[0.03] transition-colors"
                  >
                    <td className="py-2.5 pl-4 pr-2" />
                    <td className="py-2.5 px-3">
                      <button
                        type="button"
                        onClick={() => {
                          setSearch('');
                          setQuickFilter('none');
                          setCategory('all');
                          setFolderId(fld.id);
                        }}
                        className="flex items-center gap-2.5 font-medium hover:text-blue-500 cursor-pointer text-left"
                      >
                        <Folder className="w-4 h-4 text-blue-400 shrink-0" />
                        <span>{fld.name}</span>
                      </button>
                    </td>
                    <td className="py-2.5 px-3 text-xs text-zinc-500 dark:text-zinc-400">Folder</td>
                    <td className="py-2.5 px-3 text-xs font-mono tabular-nums text-right text-zinc-500">
                      —
                    </td>
                    <td className="py-2.5 px-3 text-xs font-mono tabular-nums text-zinc-500">
                      {formatDate(fld.modifiedAt)}
                    </td>
                    <td className="py-2.5 pr-4 pl-2 text-right">
                      {fld.parentId !== null && (
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => setRenameTarget({ type: 'folder', id: fld.id, name: fld.name })}
                            title="Rename folder"
                            className="p-1.5 rounded hover:bg-zinc-200 dark:hover:bg-white/10 text-zinc-400 hover:text-zinc-200 cursor-pointer"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDeleteFolder(fld)}
                            title="Delete folder"
                            className="p-1.5 rounded hover:bg-red-500/15 text-zinc-400 hover:text-red-400 cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}

                {files.map((file) => (
                  <tr
                    key={file.id}
                    className="hover:bg-zinc-50 dark:hover:bg-white/[0.03] transition-colors"
                  >
                    <td className="py-2.5 pl-4 pr-2">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(file.id)}
                        onChange={() => toggleSelect(file.id)}
                        aria-label={`Select ${file.name}`}
                      />
                    </td>
                    <td className="py-2.5 px-3 max-w-xs">
                      <button
                        type="button"
                        onClick={() => void handleOpenPreview(file)}
                        className="flex items-center gap-2.5 font-medium hover:text-blue-500 cursor-pointer text-left truncate w-full"
                      >
                        {renderCategoryIcon(file.category)}
                        <span className="truncate">{file.name}</span>
                        {file.transferStatus === 'missing' && (
                          <span className="text-xs text-red-400 shrink-0">(Missing)</span>
                        )}
                      </button>
                    </td>
                    <td className="py-2.5 px-3 text-xs text-zinc-500 dark:text-zinc-400 capitalize">
                      {file.category}
                    </td>
                    <td className="py-2.5 px-3 text-xs font-mono tabular-nums text-right text-zinc-600 dark:text-zinc-300">
                      {formatBytes(file.size)}
                    </td>
                    <td className="py-2.5 px-3 text-xs font-mono tabular-nums text-zinc-500 dark:text-zinc-400 whitespace-nowrap">
                      {formatDate(file.modifiedAt)}
                    </td>
                    <td className="py-2.5 pr-4 pl-2 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => void handleToggleFavorite(file)}
                          title="Toggle favorite"
                          className={`p-1.5 rounded hover:bg-zinc-200 dark:hover:bg-white/10 cursor-pointer ${
                            file.isFavorite ? 'text-amber-400' : 'text-zinc-400'
                          }`}
                        >
                          <Star className="w-3.5 h-3.5" fill={file.isFavorite ? 'currentColor' : 'none'} />
                        </button>
                        <a
                          href={buildContentUrl(file.id, true)}
                          title="Download file"
                          className="p-1.5 rounded hover:bg-zinc-200 dark:hover:bg-white/10 text-zinc-400 hover:text-zinc-200"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </a>
                        <button
                          type="button"
                          onClick={() => setRenameTarget({ type: 'file', id: file.id, name: file.name })}
                          title="Rename"
                          className="p-1.5 rounded hover:bg-zinc-200 dark:hover:bg-white/10 text-zinc-400 hover:text-zinc-200 cursor-pointer"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setMoveFileTarget(file);
                            setMoveDestFolderId(allFolders[0]?.id || '');
                          }}
                          title="Move to folder"
                          className="p-1.5 rounded hover:bg-zinc-200 dark:hover:bg-white/10 text-zinc-400 hover:text-zinc-200 cursor-pointer"
                        >
                          <FolderInput className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleCopy(file)}
                          title="Duplicate file"
                          className="p-1.5 rounded hover:bg-zinc-200 dark:hover:bg-white/10 text-zinc-400 hover:text-zinc-200 cursor-pointer"
                        >
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleShowProperties(file)}
                          title="Properties"
                          className="p-1.5 rounded hover:bg-zinc-200 dark:hover:bg-white/10 text-zinc-400 hover:text-zinc-200 cursor-pointer"
                        >
                          <Info className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteFile(file)}
                          title="Move to Recycle Bin"
                          className="p-1.5 rounded hover:bg-red-500/15 text-zinc-400 hover:text-red-400 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {folders.map((fld) => (
              <button
                key={fld.id}
                type="button"
                onClick={() => {
                  setSearch('');
                  setQuickFilter('none');
                  setCategory('all');
                  setFolderId(fld.id);
                }}
                className="text-left bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.08] hover:border-blue-500/50 rounded-xl p-4 transition-colors cursor-pointer"
              >
                <Folder className="w-8 h-8 text-blue-400 mb-3" />
                <div className="text-sm font-medium truncate">{fld.name}</div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">Folder</div>
              </button>
            ))}
            {files.map((file) => (
              <div
                key={file.id}
                className="bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.08] rounded-xl overflow-hidden flex flex-col"
              >
                <button
                  type="button"
                  onClick={() => void handleOpenPreview(file)}
                  className="h-32 w-full bg-zinc-100 dark:bg-[#18181B] flex items-center justify-center overflow-hidden cursor-pointer"
                >
                  {file.thumbnailPath ? (
                    <img
                      src={buildThumbnailUrl(file.id)}
                      alt={file.name}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    renderCategoryIcon(file.category)
                  )}
                </button>
                <div className="p-3 flex-1 flex flex-col justify-between gap-2">
                  <div>
                    <div className="text-xs font-medium truncate">{file.name}</div>
                    <div className="text-xs text-zinc-500 dark:text-zinc-400 font-mono tabular-nums mt-0.5">
                      {formatBytes(file.size)}
                    </div>
                  </div>
                  <div className="flex items-center justify-between pt-1 border-t border-zinc-100 dark:border-white/[0.06]">
                    <button
                      type="button"
                      onClick={() => void handleToggleFavorite(file)}
                      className={`p-1 rounded cursor-pointer ${file.isFavorite ? 'text-amber-400' : 'text-zinc-400'}`}
                    >
                      <Star className="w-3.5 h-3.5" fill={file.isFavorite ? 'currentColor' : 'none'} />
                    </button>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => void handleShowProperties(file)}
                        className="p-1 text-zinc-400 hover:text-zinc-200 cursor-pointer"
                      >
                        <Info className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDeleteFile(file)}
                        className="p-1 text-zinc-400 hover:text-red-400 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* New Folder Modal */}
      {newFolderModal && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <form
            onSubmit={handleCreateFolder}
            className="w-full max-w-sm bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.1] rounded-xl p-5 space-y-4"
          >
            <h3 className="text-sm font-semibold">Create New Folder</h3>
            <input
              type="text"
              autoFocus
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder="Folder name"
              className="w-full px-3 py-2 text-sm rounded-lg bg-zinc-50 dark:bg-[#18181B] border border-zinc-200 dark:border-white/[0.1]"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setNewFolderModal(false)}
                className="px-3 py-1.5 text-xs rounded-lg text-zinc-500 hover:text-zinc-200 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-500 text-white cursor-pointer"
              >
                Create
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Rename Modal */}
      {renameTarget && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <form
            onSubmit={handleRenameSubmit}
            className="w-full max-w-sm bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.1] rounded-xl p-5 space-y-4"
          >
            <h3 className="text-sm font-semibold">
              Rename {renameTarget.type === 'folder' ? 'Folder' : 'File'}
            </h3>
            <input
              type="text"
              autoFocus
              value={renameTarget.name}
              onChange={(e) => setRenameTarget({ ...renameTarget, name: e.target.value })}
              className="w-full px-3 py-2 text-sm rounded-lg bg-zinc-50 dark:bg-[#18181B] border border-zinc-200 dark:border-white/[0.1]"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRenameTarget(null)}
                className="px-3 py-1.5 text-xs rounded-lg text-zinc-500 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-500 text-white cursor-pointer"
              >
                Save
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Move File Modal */}
      {moveFileTarget && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <form
            onSubmit={handleMoveSubmit}
            className="w-full max-w-md bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.1] rounded-xl p-5 space-y-4"
          >
            <h3 className="text-sm font-semibold">Move “{moveFileTarget.name}”</h3>
            <select
              value={moveDestFolderId}
              onChange={(e) => setMoveDestFolderId(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-lg bg-zinc-50 dark:bg-[#18181B] border border-zinc-200 dark:border-white/[0.1]"
            >
              {allFolders.map((fld) => (
                <option key={fld.id} value={fld.id}>
                  {fld.relativePath}
                </option>
              ))}
            </select>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setMoveFileTarget(null)}
                className="px-3 py-1.5 text-xs rounded-lg text-zinc-500 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-500 text-white cursor-pointer"
              >
                Move File
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Preview Modal */}
      {previewFile && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-6">
          <div className="w-full max-w-4xl max-h-[90vh] bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.1] rounded-xl flex flex-col overflow-hidden">
            <div className="px-5 py-3.5 border-b border-zinc-200 dark:border-white/[0.08] flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm font-semibold truncate">{previewFile.name}</div>
                <div className="text-xs text-zinc-500 font-mono tabular-nums">
                  {formatBytes(previewFile.size)} · {previewFile.mimeType}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleOpenInOs(previewFile)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-zinc-100 dark:bg-white/[0.08] hover:bg-zinc-200 dark:hover:bg-white/[0.14] cursor-pointer"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  Open in Default App
                </button>
                <a
                  href={buildContentUrl(previewFile.id, true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-blue-600 hover:bg-blue-500 text-white"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download
                </a>
                <button
                  type="button"
                  onClick={() => setPreviewFile(null)}
                  className="p-1.5 rounded-lg hover:bg-zinc-200 dark:hover:bg-white/10 cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-6 flex items-center justify-center bg-zinc-50 dark:bg-[#141417]">
              {previewFile.category === 'photo' ? (
                <img
                  src={buildContentUrl(previewFile.id)}
                  alt={previewFile.name}
                  className="max-h-[70vh] max-w-full object-contain rounded"
                />
              ) : previewFile.category === 'video' ? (
                <video
                  src={buildContentUrl(previewFile.id)}
                  controls
                  autoPlay
                  className="max-h-[70vh] max-w-full rounded"
                />
              ) : previewFile.category === 'audio' ? (
                <audio src={buildContentUrl(previewFile.id)} controls className="w-full max-w-md" />
              ) : previewFile.extension === '.pdf' ? (
                <iframe
                  src={buildContentUrl(previewFile.id)}
                  title={previewFile.name}
                  className="w-full h-[68vh] rounded border border-zinc-200 dark:border-white/[0.08]"
                />
              ) : previewText !== null ? (
                <pre className="w-full max-h-[68vh] overflow-auto p-4 rounded-lg bg-white dark:bg-[#1C1C20] border border-zinc-200 dark:border-white/[0.08] text-xs font-mono whitespace-pre-wrap">
                  {previewText}
                </pre>
              ) : (
                <div className="text-center space-y-3">
                  <FileIcon className="w-12 h-12 text-zinc-400 mx-auto" />
                  <div className="text-sm text-zinc-500">
                    Inline preview unavailable for {previewFile.extension || 'this'} format.
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Properties Modal */}
      {propertiesData && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="w-full max-w-lg bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.1] rounded-xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">File Properties</h3>
              <button
                type="button"
                onClick={() => setPropertiesData(null)}
                className="p-1 text-zinc-400 hover:text-zinc-200 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-2.5 text-xs">
              <div className="flex justify-between gap-4 py-1.5 border-b border-zinc-100 dark:border-white/[0.06]">
                <span className="text-zinc-500">Name</span>
                <span className="font-medium text-right break-all">{propertiesData.file.name}</span>
              </div>
              <div className="flex justify-between gap-4 py-1.5 border-b border-zinc-100 dark:border-white/[0.06]">
                <span className="text-zinc-500">Size</span>
                <span className="font-mono tabular-nums">{formatBytes(propertiesData.file.size)}</span>
              </div>
              <div className="flex justify-between gap-4 py-1.5 border-b border-zinc-100 dark:border-white/[0.06]">
                <span className="text-zinc-500">Disk Path</span>
                <span className="font-mono text-right break-all">{propertiesData.absolutePath}</span>
              </div>
              <div className="flex justify-between gap-4 py-1.5 border-b border-zinc-100 dark:border-white/[0.06]">
                <span className="text-zinc-500">SHA-256</span>
                <span className="font-mono text-right break-all">
                  {propertiesData.file.sha256 || 'Pending scan'}
                </span>
              </div>
              <div className="flex justify-between gap-4 py-1.5 border-b border-zinc-100 dark:border-white/[0.06]">
                <span className="text-zinc-500">Imported</span>
                <span className="font-mono tabular-nums">{formatDate(propertiesData.file.importedAt)}</span>
              </div>
              <div className="flex justify-between gap-4 py-1.5">
                <span className="text-zinc-500">Origin Device</span>
                <span>{propertiesData.file.deviceOrigin}</span>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => void handleCopyPath(propertiesData.file)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-zinc-100 dark:bg-white/[0.08] cursor-pointer"
              >
                <Check className="w-3.5 h-3.5" />
                Copy Disk Path
              </button>
              <button
                type="button"
                onClick={() => void handleOpenInOs(propertiesData.file)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-blue-600 text-white cursor-pointer"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Open in OS
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

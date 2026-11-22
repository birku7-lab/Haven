import {
  ChevronLeft,
  ChevronRight,
  Download,
  Film,
  Folder,
  Image as ImageIcon,
  Pause,
  Play,
  Search,
  Star,
  X,
} from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { api, buildContentUrl, buildThumbnailUrl } from '../lib/api';
import { formatBytes, formatDate, formatShortDate } from '../lib/format';
import type { FileRecord } from '../types';

interface MediaViewProps {
  refreshTrigger: number;
}

export function MediaView({ refreshTrigger }: MediaViewProps) {
  const [mediaType, setMediaType] = useState<'all' | 'photo' | 'video'>('all');
  const [viewMode, setViewMode] = useState<'timeline' | 'albums'>('timeline');
  const [sortBy, setSortBy] = useState<'modifiedAt' | 'size'>('modifiedAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [search, setSearch] = useState('');
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [selectedAlbumFolderId, setSelectedAlbumFolderId] = useState<string | undefined>(undefined);

  const [items, setItems] = useState<FileRecord[]>([]);
  const [albums, setAlbums] = useState<Array<{ folderId: string | null; name: string; count: number; coverId: string }>>([]);
  const [counts, setCounts] = useState({ photos: 0, videos: 0 });
  const [loading, setLoading] = useState(true);

  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [slideshow, setSlideshow] = useState(false);

  const loadMedia = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getMedia({
        type: mediaType,
        sortBy,
        sortDir,
        search: search || undefined,
        favorites: favoriteOnly,
        folderId: selectedAlbumFolderId,
      });
      setItems(res.items);
      setAlbums(res.albums);
      setCounts(res.counts);
    } finally {
      setLoading(false);
    }
  }, [mediaType, sortBy, sortDir, search, favoriteOnly, selectedAlbumFolderId]);

  useEffect(() => {
    void loadMedia();
  }, [loadMedia, refreshTrigger]);

  useEffect(() => {
    if (!slideshow || activeIndex === null || items.length === 0) return;
    const current = items[activeIndex];
    if (current?.category === 'video') return; // Wait on videos
    const timer = setInterval(() => {
      setActiveIndex((prev) => (prev === null ? null : (prev + 1) % items.length));
    }, 3500);
    return () => clearInterval(timer);
  }, [slideshow, activeIndex, items]);

  const activeItem = activeIndex !== null ? items[activeIndex] || null : null;

  const groupedByDate = items.reduce<Array<{ label: string; entries: Array<{ item: FileRecord; index: number }> }>>(
    (acc, item, index) => {
      const label = formatShortDate(item.modifiedAt);
      const last = acc[acc.length - 1];
      if (last && last.label === label) {
        last.entries.push({ item, index });
      } else {
        acc.push({ label, entries: [{ item, index }] });
      }
      return acc;
    },
    []
  );

  const toggleFav = async (item: FileRecord) => {
    await api.updateFile(item.id, { isFavorite: !item.isFavorite });
    await loadMedia();
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header Toolbar */}
      <div className="px-6 py-4 border-b border-zinc-200 dark:border-white/[0.08] bg-white dark:bg-[#1F1F23] flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="flex items-center p-1 rounded-lg bg-zinc-100 dark:bg-[#18181B] border border-zinc-200 dark:border-white/[0.08]">
            {(['all', 'photo', 'video'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setMediaType(t)}
                className={`px-3 py-1 rounded-md text-xs font-medium capitalize cursor-pointer ${
                  mediaType === t
                    ? 'bg-white dark:bg-white/10 shadow-xs text-zinc-900 dark:text-zinc-100'
                    : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200'
                }`}
              >
                {t === 'all'
                  ? `All (${counts.photos + counts.videos})`
                  : t === 'photo'
                    ? `Photos (${counts.photos})`
                    : `Videos (${counts.videos})`}
              </button>
            ))}
          </div>

          <div className="flex items-center p-1 rounded-lg bg-zinc-100 dark:bg-[#18181B] border border-zinc-200 dark:border-white/[0.08]">
            <button
              type="button"
              onClick={() => {
                setViewMode('timeline');
                setSelectedAlbumFolderId(undefined);
              }}
              className={`px-3 py-1 rounded-md text-xs font-medium cursor-pointer ${
                viewMode === 'timeline'
                  ? 'bg-white dark:bg-white/10 shadow-xs'
                  : 'text-zinc-500'
              }`}
            >
              Timeline
            </button>
            <button
              type="button"
              onClick={() => setViewMode('albums')}
              className={`px-3 py-1 rounded-md text-xs font-medium cursor-pointer ${
                viewMode === 'albums'
                  ? 'bg-white dark:bg-white/10 shadow-xs'
                  : 'text-zinc-500'
              }`}
            >
              Albums ({albums.length})
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search media..."
              className="pl-8 pr-3 py-1.5 w-44 text-xs rounded-lg bg-zinc-100 dark:bg-[#18181B] border border-zinc-200 dark:border-white/[0.08]"
            />
          </div>

          <button
            type="button"
            onClick={() => setFavoriteOnly(!favoriteOnly)}
            className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border cursor-pointer ${
              favoriteOnly
                ? 'bg-amber-500/15 border-amber-500/30 text-amber-500'
                : 'bg-zinc-100 dark:bg-[#18181B] border-zinc-200 dark:border-white/[0.08] text-zinc-500'
            }`}
          >
            <Star className="w-3.5 h-3.5" fill={favoriteOnly ? 'currentColor' : 'none'} />
            Favorites
          </button>

          <select
            value={`${sortBy}:${sortDir}`}
            onChange={(e) => {
              const [col, dir] = e.target.value.split(':') as [typeof sortBy, typeof sortDir];
              setSortBy(col);
              setSortDir(dir);
            }}
            className="text-xs px-2.5 py-1.5 rounded-lg bg-zinc-100 dark:bg-[#18181B] border border-zinc-200 dark:border-white/[0.08]"
          >
            <option value="modifiedAt:desc">Date (Newest)</option>
            <option value="modifiedAt:asc">Date (Oldest)</option>
            <option value="size:desc">Size (Largest)</option>
            <option value="size:asc">Size (Smallest)</option>
          </select>
        </div>
      </div>

      {/* Main Gallery */}
      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="aspect-square rounded-lg bg-zinc-200/60 dark:bg-white/[0.04] animate-pulse" />
            ))}
          </div>
        ) : viewMode === 'albums' && !selectedAlbumFolderId ? (
          albums.length === 0 ? (
            <div className="py-20 text-center text-xs text-zinc-500">No media albums found yet.</div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
              {albums.map((alb) => (
                <button
                  key={alb.folderId || 'root'}
                  type="button"
                  onClick={() => setSelectedAlbumFolderId(alb.folderId || undefined)}
                  className="text-left bg-white dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.08] hover:border-blue-500/50 rounded-xl overflow-hidden cursor-pointer"
                >
                  <div className="h-36 bg-zinc-100 dark:bg-[#18181B] flex items-center justify-center">
                    <img
                      src={buildThumbnailUrl(alb.coverId)}
                      alt={alb.name}
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display = 'none';
                      }}
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <div className="p-3.5 flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      <Folder className="w-4 h-4 text-blue-400 shrink-0" />
                      <span className="text-sm font-medium truncate">{alb.name}</span>
                    </div>
                    <span className="text-xs font-mono tabular-nums text-zinc-500">{alb.count}</span>
                  </div>
                </button>
              ))}
            </div>
          )
        ) : items.length === 0 ? (
          <div className="py-20 text-center border border-dashed border-zinc-300 dark:border-white/[0.12] rounded-xl">
            <ImageIcon className="w-8 h-8 text-zinc-400 mx-auto mb-3" />
            <div className="text-sm font-medium">No photos or videos in library</div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
              Import photos or videos in the File Manager to build your timeline and albums.
            </p>
          </div>
        ) : (
          <div className="space-y-8">
            {selectedAlbumFolderId && (
              <button
                type="button"
                onClick={() => setSelectedAlbumFolderId(undefined)}
                className="inline-flex items-center gap-1.5 text-xs text-blue-500 hover:underline cursor-pointer"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                Back to all albums
              </button>
            )}
            {groupedByDate.map((group) => (
              <div key={group.label} className="space-y-3">
                <h3 className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">
                  {group.label} · {group.entries.length} item{group.entries.length === 1 ? '' : 's'}
                </h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
                  {group.entries.map(({ item, index }) => (
                    <div
                      key={item.id}
                      className="group relative aspect-square rounded-lg overflow-hidden bg-zinc-200 dark:bg-[#1F1F23] border border-zinc-200 dark:border-white/[0.08]"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setSlideshow(false);
                          setActiveIndex(index);
                        }}
                        className="w-full h-full flex items-center justify-center cursor-pointer"
                      >
                        {item.category === 'photo' ? (
                          <img
                            src={item.thumbnailPath ? buildThumbnailUrl(item.id) : buildContentUrl(item.id)}
                            alt={item.name}
                            loading="lazy"
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="w-full h-full flex flex-col items-center justify-center bg-zinc-900 text-zinc-200 p-3">
                            <Film className="w-7 h-7 text-blue-400 mb-2" />
                            <span className="text-xs truncate w-full text-center">{item.name}</span>
                          </div>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => void toggleFav(item)}
                        className={`absolute top-2 right-2 p-1.5 rounded-md bg-black/50 text-white transition-opacity cursor-pointer ${
                          item.isFavorite ? 'opacity-100 text-amber-400' : 'opacity-0 group-hover:opacity-100'
                        }`}
                      >
                        <Star className="w-3.5 h-3.5" fill={item.isFavorite ? 'currentColor' : 'none'} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Fullscreen Lightbox & Video Streaming Viewer */}
      {activeItem && activeIndex !== null && (
        <div className="fixed inset-0 z-50 bg-black/95 text-zinc-100 flex flex-col">
          <div className="px-6 py-3.5 border-b border-white/10 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-semibold truncate">{activeItem.name}</div>
              <div className="text-xs text-zinc-400 font-mono tabular-nums">
                {formatBytes(activeItem.size)} · {formatDate(activeItem.modifiedAt)} ·{' '}
                {activeItem.relativePath}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setSlideshow(!slideshow)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-white/10 hover:bg-white/15 cursor-pointer"
              >
                {slideshow ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                {slideshow ? 'Pause Slideshow' : 'Slideshow'}
              </button>
              <a
                href={buildContentUrl(activeItem.id, true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-white/10 hover:bg-white/15"
              >
                <Download className="w-3.5 h-3.5" />
                Download
              </a>
              <button
                type="button"
                onClick={() => {
                  setSlideshow(false);
                  setActiveIndex(null);
                }}
                className="p-1.5 rounded-lg hover:bg-white/10 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          <div className="flex-1 relative flex items-center justify-center p-6 overflow-hidden">
            {items.length > 1 && (
              <button
                type="button"
                onClick={() => setActiveIndex((activeIndex - 1 + items.length) % items.length)}
                className="absolute left-4 p-3 rounded-full bg-black/60 hover:bg-black/80 text-white cursor-pointer"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
            )}

            {activeItem.category === 'photo' ? (
              <img
                src={buildContentUrl(activeItem.id)}
                alt={activeItem.name}
                className="max-h-full max-w-full object-contain"
              />
            ) : (
              <video
                key={activeItem.id}
                src={buildContentUrl(activeItem.id)}
                controls
                autoPlay
                className="max-h-full max-w-full"
              />
            )}

            {items.length > 1 && (
              <button
                type="button"
                onClick={() => setActiveIndex((activeIndex + 1) % items.length)}
                className="absolute right-4 p-3 rounded-full bg-black/60 hover:bg-black/80 text-white cursor-pointer"
              >
                <ChevronRight className="w-5 h-5" />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

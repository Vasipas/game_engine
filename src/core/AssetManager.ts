import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";

// ─── Types & Constants ───────────────────────────────────────────────────────

export enum Priority {
  CRITICAL = 0,
  HIGH = 1,
  NORMAL = 2,
  LOW = 3,
}

export enum AssetType {
  GLTF = "gltf",
  TEXTURE = "texture",
  CUBE_TEXTURE = "cubeTexture",
  RGBE = "rgbe",
  AUDIO = "audio",
  JSON = "json",
  BINARY = "binary",
}

interface DefaultOptions {
  maxConcurrent: number;
  maxCacheSize: number;
  defaultTTL: number;
  maxRetries: number;
  retryDelay: number;
  dracoPath: string;
  ktx2TranscoderPath: string;
  textureEncoding: THREE.ColorSpace;
  generateMipmaps: boolean;
  anisotropy: number;
}

const DEFAULT_OPTIONS: DefaultOptions = {
  maxConcurrent: 6,
  maxCacheSize: 512,
  defaultTTL: 300_000,
  maxRetries: 3,
  retryDelay: 500,
  dracoPath: "/dracopath/",
  ktx2TranscoderPath: "/basis/",
  textureEncoding: THREE.SRGBColorSpace,
  generateMipmaps: true,
  anisotropy: 4,
};

interface LoadOptions {
  priority?: Priority;
  type?: AssetType;
  ttl?: number;
  colorSpace?: THREE.ColorSpace;
  generateMipmaps?: boolean;
  anisotropy?: number;
  wrapS?: THREE.Wrapping;
  wrapT?: THREE.Wrapping;
  faces?: string | string[];
}

type LoadItem = string | ({ url: string } & LoadOptions);

// ─── Asset Group Handle ──────────────────────────────────────────────────────

export type GroupProgressCallback = (progress: {
  loaded: number;
  total: number;
  ratio: number;
  url: string;
}) => void;

/**
 * Returned by `loadGroup()`. Attach progress callbacks, await the result,
 * or cancel all pending loads in the group.
 *
 * @example
 * const handle = manager.loadGroup("Level_1", urls);
 * handle.onProgress(({ ratio }) => progressBar.style.width = `${ratio * 100}%`);
 * const assets = await handle.promise;
 */
export class AssetGroupHandle {
  readonly promise: Promise<Map<string, any>>;

  #progressCallbacks = new Set<GroupProgressCallback>();
  #loadedCount = 0;
  readonly #total: number;
  #cancelFn: () => void;

  /** @internal */
  constructor(
    promise: Promise<Map<string, any>>,
    total: number,
    cancelFn: () => void,
  ) {
    this.promise = promise;
    this.#total = total;
    this.#cancelFn = cancelFn;
  }

  /**
   * Register a callback for per-group load progress.
   * Called every time one asset in this group finishes loading.
   */
  onProgress(cb: GroupProgressCallback): this {
    this.#progressCallbacks.add(cb);
    return this;
  }

  /** Remove a previously registered progress callback. */
  offProgress(cb: GroupProgressCallback): this {
    this.#progressCallbacks.delete(cb);
    return this;
  }

  /** Cancel all still-pending loads that belong to this group. */
  cancel(): void {
    this.#cancelFn();
  }

  /** @internal — called by AssetManager when an asset finishes */
  _notifyProgress(url: string): void {
    this.#loadedCount++;
    const payload = {
      loaded: this.#loadedCount,
      total: this.#total,
      ratio: this.#total > 0 ? this.#loadedCount / this.#total : 1,
      url,
    };
    this.#progressCallbacks.forEach((cb) => cb(payload));
  }
}

// ─── Helper Utilities ────────────────────────────────────────────────────────

class EventEmitter {
  #handlers = new Map<string, Set<(...args: any[]) => void>>();

  on(event: string, fn: (...args: any[]) => void): this {
    if (!this.#handlers.has(event)) this.#handlers.set(event, new Set());
    this.#handlers.get(event)!.add(fn);
    return this;
  }

  off(event: string, fn: (...args: any[]) => void): this {
    this.#handlers.get(event)?.delete(fn);
    return this;
  }

  once(event: string, fn: (...args: any[]) => void): this {
    const wrapper = (...args: any[]) => {
      fn(...args);
      this.off(event, wrapper);
    };
    return this.on(event, wrapper);
  }

  emit(event: string, ...args: any[]): void {
    this.#handlers.get(event)?.forEach((fn) => fn(...args));
  }
}

function estimateSize(asset: any, type: AssetType): number {
  if (!asset) return 0;
  switch (type) {
    case AssetType.TEXTURE: {
      const t = asset as THREE.Texture;
      if (!t.image) return 0;
      const { width = 0, height = 0 } = t.image;
      return width * height * 4 * (t.generateMipmaps ? 1.33 : 1);
    }
    case AssetType.GLTF: {
      let bytes = 0;
      const scene = asset.scene as THREE.Object3D;
      if (scene) {
        scene.traverse((obj: any) => {
          if (obj.geometry?.attributes) {
            Object.values(obj.geometry.attributes).forEach((attr: any) => {
              bytes += attr.array?.byteLength ?? 0;
            });
          }
          if (obj.geometry?.index) {
            bytes += obj.geometry.index.array?.byteLength ?? 0;
          }
        });
      }
      return bytes;
    }
    default:
      return 0;
  }
}

// ─── LRU Cache ───────────────────────────────────────────────────────────────

interface CacheEntry {
  asset: any;
  type: AssetType;
  bytes: number;
  expires: number;
  lastUsed: number;
  /** [1] Reference count — entry won't be evicted while refs > 0. */
  refs: number;
}

class LRUCache extends EventEmitter {
  #map = new Map<string, CacheEntry>();
  #bytes = 0;
  #maxBytes: number;
  #defaultTTL: number;

  constructor(maxMB = 512, defaultTTL = 0) {
    super();
    this.#maxBytes = maxMB * 1024 * 1024;
    this.#defaultTTL = defaultTTL;
  }

  get size(): number {
    return this.#map.size;
  }
  get bytes(): number {
    return this.#bytes;
  }

  set(url: string, asset: any, type: AssetType, ttl = this.#defaultTTL): this {
    if (this.#map.has(url)) this.#evict(url);
    const bytes = estimateSize(asset, type);
    const expires = ttl > 0 ? Date.now() + ttl : Infinity;
    this.#map.set(url, {
      asset,
      type,
      bytes,
      expires,
      lastUsed: Date.now(),
      refs: 0, // [1] start unpinned
    });
    this.#bytes += bytes;
    this.#enforceBudget();
    return this;
  }

  get(url: string): any {
    const entry = this.#map.get(url);
    if (!entry) return null;
    if (Date.now() > entry.expires) {
      this.#evict(url);
      return null;
    }
    entry.lastUsed = Date.now();
    this.#map.delete(url);
    this.#map.set(url, entry);
    return entry.asset;
  }

  has(url: string): boolean {
    const entry = this.#map.get(url);
    if (!entry) return false;
    if (Date.now() > entry.expires) {
      this.#evict(url);
      return false;
    }
    return true;
  }

  // ─── [1] Reference counting ──────────────────────────────────────────────

  /**
   * Increment the reference counter for an entry.
   * While refs > 0 the entry is "pinned" and will not be LRU-evicted.
   * Returns the new ref count, or -1 if the entry doesn't exist.
   */
  acquire(url: string): number {
    const entry = this.#map.get(url);
    if (!entry) return -1;
    entry.refs++;
    return entry.refs;
  }

  /**
   * Decrement the reference counter.
   * When refs reach 0 the entry becomes evictable again.
   * Optionally pass `dispose = true` to immediately evict if refs hit 0.
   * Returns the new ref count, or -1 if the entry doesn't exist.
   */
  release(url: string, dispose = false): number {
    const entry = this.#map.get(url);
    if (!entry) return -1;
    entry.refs = Math.max(0, entry.refs - 1);
    if (dispose && entry.refs === 0) {
      this.#evict(url, true);
      return 0;
    }
    return entry.refs;
  }

  /** Current ref count for a url (0 = unpinned, -1 = not in cache). */
  refCount(url: string): number {
    return this.#map.get(url)?.refs ?? -1;
  }

  // ─── Existing methods ────────────────────────────────────────────────────

  delete(url: string): void {
    if (this.#map.has(url)) this.#evict(url, true);
  }

  clear(dispose = true): void {
    for (const url of [...this.#map.keys()]) this.#evict(url, dispose);
  }

  stats() {
    return {
      entries: this.#map.size,
      usedMB: +(this.#bytes / 1024 / 1024).toFixed(2),
      maxMB: +(this.#maxBytes / 1024 / 1024).toFixed(2),
      usagePercent: +((this.#bytes / this.#maxBytes) * 100).toFixed(1),
    };
  }

  #evict(url: string, dispose = false): void {
    const entry = this.#map.get(url);
    if (!entry) return;
    this.#bytes -= entry.bytes;
    this.#map.delete(url);
    if (dispose) this.#dispose(entry.asset, entry.type);
    this.emit("evict", url, entry.asset);
  }

  #enforceBudget(): void {
    // Walk entries oldest-first; skip pinned ones (refs > 0)
    for (const [url, entry] of this.#map) {
      if (this.#bytes <= this.#maxBytes) break;
      if (entry.refs > 0) continue; // [1] pinned — skip
      this.#evict(url, true);
    }
  }

  #dispose(asset: any, type: AssetType): void {
    if (!asset) return;
    try {
      switch (type) {
        case AssetType.TEXTURE:
        case AssetType.RGBE:
        case AssetType.CUBE_TEXTURE:
          asset.dispose?.();
          break;
        case AssetType.GLTF:
          asset.scene?.traverse((obj: any) => {
            if (obj.geometry) obj.geometry.dispose();
            if (obj.material) {
              const mats = Array.isArray(obj.material)
                ? obj.material
                : [obj.material];
              mats.forEach((m: any) => {
                Object.values(m).forEach(
                  (v: any) => v?.isTexture && v.dispose(),
                );
                m.dispose();
              });
            }
          });
          break;
      }
    } catch (e) {
      console.warn("[AssetManager] dispose error:", e);
    }
  }
}

// ─── Priority Queue ──────────────────────────────────────────────────────────

interface QueueTask {
  url: string;
  opts: LoadOptions;
  resolve: (value: any) => void;
  reject: (reason: any) => void;
}

class PriorityQueue {
  #buckets: Array<Array<QueueTask>> = [[], [], [], []];

  enqueue(item: QueueTask, priority: Priority = Priority.NORMAL): void {
    this.#buckets[priority].push(item);
  }

  dequeue(): QueueTask | null {
    for (const bucket of this.#buckets) {
      if (bucket.length > 0) return bucket.shift() || null;
    }
    return null;
  }

  get size(): number {
    return this.#buckets.reduce((s, b) => s + b.length, 0);
  }

  remove(predicate: (item: QueueTask) => boolean): void {
    this.#buckets.forEach((b, i) => {
      this.#buckets[i] = b.filter((item) => !predicate(item));
    });
  }
}

// ─── Main AssetManager ───────────────────────────────────────────────────────

export class AssetManager extends EventEmitter {
  #cache: LRUCache;
  #queue = new PriorityQueue();
  #inflight = new Map<string, Promise<any>>();
  #active = 0;
  #opts: DefaultOptions;
  #loaders: {
    gltf: GLTFLoader;
    texture: THREE.TextureLoader;
    cubeTexture: THREE.CubeTextureLoader;
    rgbe: RGBELoader;
    ktx2?: KTX2Loader;
  } = {} as any;
  #renderer: THREE.WebGLRenderer | null;
  #inflightControllers = new Map<string, AbortController>();
  #stats = { loaded: 0, failed: 0, cacheHits: 0 };

  // [2] Group registry: groupName → Set of URLs in the group
  #groups = new Map<string, Set<string>>();

  constructor(
    options: Partial<DefaultOptions> = {},
    renderer: THREE.WebGLRenderer | null = null,
  ) {
    super();
    this.#opts = { ...DEFAULT_OPTIONS, ...options };
    this.#renderer = renderer;
    this.#cache = new LRUCache(this.#opts.maxCacheSize, this.#opts.defaultTTL);
    this.#cache.on("evict", (url: string) => this.emit("evict", url));
    this.#initLoaders();
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  load(url: string, options: LoadOptions = {}): Promise<any> {
    return this.#scheduleLoad(url, options);
  }

  async loadAll(items: LoadItem[]): Promise<Map<string, any>> {
    const results = new Map<string, any>();
    await Promise.allSettled(
      items.map(async (item) => {
        const url = typeof item === "string" ? item : item.url;
        const opts = typeof item === "string" ? {} : item;
        try {
          results.set(url, await this.load(url, opts));
        } catch (e) {
          results.set(url, { error: e });
          this.emit("error", url, e);
        }
      }),
    );
    return results;
  }

  preload(items: LoadItem[], defaultPriority: Priority = Priority.LOW): void {
    items.forEach((item) => {
      const url = typeof item === "string" ? item : item.url;
      const opts: LoadOptions =
        typeof item === "string"
          ? { priority: defaultPriority }
          : { priority: defaultPriority, ...item };
      if (!this.#cache.has(url) && !this.#inflight.has(url)) {
        this.#scheduleLoad(url, opts).catch(() => {});
      }
    });
  }

  // ─── [2] Asset Groups ──────────────────────────────────────────────────────

  /**
   * Load a named group of assets.
   * Every URL is reference-counted so that `unloadGroup()` only disposes
   * assets that are not referenced by another group.
   *
   * @param name   Unique group identifier (e.g. "Level_1_Assets")
   * @param items  Same format as `loadAll()` — strings or `{url, ...opts}` objects
   * @returns      An `AssetGroupHandle` — attach `.onProgress()` or await `.promise`
   *
   * @example
   * const handle = manager.loadGroup("Level_1", [
   *   "assets/env.hdr",
   *   { url: "assets/player.glb", priority: Priority.HIGH },
   * ]);
   * handle.onProgress(({ ratio }) => bar.value = ratio);
   * const assets = await handle.promise;
   */
  loadGroup(name: string, items: LoadItem[]): AssetGroupHandle {
    // Register or extend the group's URL set
    if (!this.#groups.has(name)) this.#groups.set(name, new Set());
    const groupUrls = this.#groups.get(name)!;

    const urls = items.map((item) =>
      typeof item === "string" ? item : item.url,
    );
    urls.forEach((url) => groupUrls.add(url));

    // [3] Build the handle before firing loads so callbacks can be attached
    //     synchronously before any micro-task resolves.
    let cancelled = false;
    const handle = new AssetGroupHandle(
      /* promise — filled below */ Promise.resolve(new Map()),
      urls.length,
      () => {
        cancelled = true;
        urls.forEach((url) => this.cancel(url));
      },
    );

    // Replace the placeholder promise with the real one
    const realPromise = (async () => {
      const results = new Map<string, any>();
      await Promise.allSettled(
        items.map(async (item) => {
          const url = typeof item === "string" ? item : item.url;
          const opts: LoadOptions = typeof item === "string" ? {} : item;
          if (cancelled) return;
          try {
            const asset = await this.#scheduleLoad(url, opts);
            // [1] Acquire a ref on behalf of this group
            this.#cache.acquire(url);
            results.set(url, asset);
          } catch (e) {
            results.set(url, { error: e });
            this.emit("error", url, e);
          } finally {
            // [3] Notify group-level progress regardless of success/failure
            handle._notifyProgress(url);
          }
        }),
      );
      return results;
    })();

    // Patch the handle's promise (the constructor stored a placeholder)
    (handle as any).promise = realPromise;
    return handle;
  }

  /**
   * Release all assets that belong exclusively to `name`.
   * Assets shared with another group are ref-decremented but not disposed.
   *
   * @param name     Group identifier passed to `loadGroup()`
   * @param dispose  When true, immediately dispose GPU resources once refs hit 0
   */
  unloadGroup(name: string, dispose = true): void {
    const groupUrls = this.#groups.get(name);
    if (!groupUrls) {
      console.warn(`[AssetManager] unloadGroup: unknown group "${name}"`);
      return;
    }

    groupUrls.forEach((url) => {
      // [1] Release this group's ref; dispose only when no one else holds it
      this.#cache.release(url, dispose);
    });

    this.#groups.delete(name);
    this.emit("groupUnloaded", name);
  }

  /** Returns the URLs currently registered in a group (snapshot). */
  getGroupUrls(name: string): string[] {
    return [...(this.#groups.get(name) ?? [])];
  }

  /** List all registered group names. */
  get groupNames(): string[] {
    return [...this.#groups.keys()];
  }

  // ─── [1] Reference counting (direct access) ────────────────────────────────

  /**
   * Manually pin an asset so it won't be LRU-evicted.
   * You must pair every `acquire()` with a corresponding `release()`.
   */
  acquire(url: string): number {
    return this.#cache.acquire(url);
  }

  /**
   * Release a manual pin acquired with `acquire()`.
   * Pass `dispose = true` to immediately free GPU memory when refs hit 0.
   */
  release(url: string, dispose = false): number {
    return this.#cache.release(url, dispose);
  }

  /** Current reference count (-1 if not cached). */
  refCount(url: string): number {
    return this.#cache.refCount(url);
  }

  // ─── Cache helpers ────────────────────────────────────────────────────────

  isCached(url: string): boolean {
    return this.#cache.has(url);
  }

  getFromCache(url: string): any {
    return this.#cache.get(url) ?? null;
  }

  evict(url: string): void {
    this.#cache.delete(url);
  }

  clearCache(dispose = true): void {
    this.#cache.clear(dispose);
  }

  cancel(url: string): void {
    this.#queue.remove((item) => item.url === url);
    const ctrl = this.#inflightControllers.get(url);
    ctrl?.abort();
    this.#inflightControllers.delete(url);
  }

  stats() {
    return {
      ...this.#stats,
      queue: this.#queue.size,
      active: this.#active,
      cache: this.#cache.stats(),
      groups: this.#groups.size, // [2]
    };
  }

  dispose(): void {
    // Release all groups before clearing the cache
    for (const name of [...this.#groups.keys()]) {
      this.unloadGroup(name, false);
    }
    this.#cache.clear(true);
    this.#inflight.clear();
    this.emit("dispose");
  }

  // ─── Private Methods ───────────────────────────────────────────────────────

  #scheduleLoad(url: string, opts: LoadOptions = {}): Promise<any> {
    const cached = this.#cache.get(url);
    if (cached) {
      this.#stats.cacheHits++;
      this.emit("cacheHit", url);
      return Promise.resolve(cached);
    }

    if (this.#inflight.has(url)) return this.#inflight.get(url)!;

    const priority = opts.priority ?? Priority.NORMAL;
    const promise = new Promise<any>((resolve, reject) => {
      this.#queue.enqueue({ url, opts, resolve, reject }, priority);
    });

    this.#inflight.set(url, promise);
    promise.finally(() => this.#inflight.delete(url));
    this.#drain();
    return promise;
  }

  #drain(): void {
    while (this.#active < this.#opts.maxConcurrent) {
      const task = this.#queue.dequeue();
      if (!task) break;
      this.#active++;
      this.#execute(task).finally(() => {
        this.#active--;
        this.#drain();
      });
    }
  }

  async #execute(task: QueueTask): Promise<void> {
    const { url, opts, resolve, reject } = task;
    const abortCtrl = new AbortController();
    this.#inflightControllers.set(url, abortCtrl);

    let attempt = 0;
    while (attempt <= this.#opts.maxRetries) {
      try {
        this.emit("loadStart", url, attempt);
        const asset = await this.#loadAsset(url, opts, abortCtrl.signal);
        const type = opts.type ?? this.detectType(url);
        this.#cache.set(url, asset, type, opts.ttl);
        this.#stats.loaded++;
        this.emit("load", url, asset);
        this.#inflightControllers.delete(url);
        resolve(asset);
        return;
      } catch (err: any) {
        if (err.name === "AbortError") {
          reject(err);
          return;
        }
        attempt++;
        if (attempt > this.#opts.maxRetries) {
          this.#stats.failed++;
          this.emit("error", url, err);
          this.#inflightControllers.delete(url);
          reject(err);
          return;
        }
        const delay = this.#opts.retryDelay * 2 ** (attempt - 1);
        this.emit("retry", url, attempt, delay);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  async #loadAsset(
    url: string,
    opts: LoadOptions,
    signal: AbortSignal,
  ): Promise<any> {
    const type = opts.type ?? this.detectType(url);
    const onProgress = (e: ProgressEvent) => {
      if (e.lengthComputable) {
        this.emit("progress", url, e.loaded / e.total, e.loaded, e.total);
      }
    };

    switch (type) {
      case AssetType.GLTF:
        return this.loadGLTF(url, onProgress, signal);
      case AssetType.TEXTURE:
        return this.loadTexture(url, opts, onProgress, signal);
      case AssetType.CUBE_TEXTURE:
        return this.loadCubeTexture(url, opts, onProgress, signal);
      case AssetType.RGBE:
        return this.loadRGBE(url, onProgress, signal);
      case AssetType.AUDIO:
        return this.loadAudio(url, signal);
      case AssetType.JSON:
        return this.loadJSON(url, signal);
      case AssetType.BINARY:
        return this.loadBinary(url, signal);
      default:
        throw new Error(`[AssetManager] Unknown type for: ${url}`);
    }
  }

  // ─── Loaders ──────────────────────────────────────────────────────────────

  private loadGLTF(
    url: string,
    onProgress: (e: ProgressEvent) => void,
    _signal: AbortSignal,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      this.#loaders.gltf.load(url, resolve, onProgress, reject);
    });
  }

  private loadTexture(
    url: string,
    opts: LoadOptions,
    onProgress: (e: ProgressEvent) => void,
    _signal: AbortSignal,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const loader = url.endsWith(".ktx2")
        ? this.#loaders.ktx2
        : this.#loaders.texture;
      loader!.load(
        url,
        (tex: THREE.Texture) => {
          tex.colorSpace = opts.colorSpace ?? this.#opts.textureEncoding;
          if (opts.generateMipmaps !== undefined)
            tex.generateMipmaps = opts.generateMipmaps;
          if (this.#opts.anisotropy) tex.anisotropy = this.#opts.anisotropy;
          if (opts.wrapS !== undefined) tex.wrapS = opts.wrapS;
          if (opts.wrapT !== undefined) tex.wrapT = opts.wrapT;
          tex.needsUpdate = true;
          resolve(tex);
        },
        onProgress,
        reject,
      );
    });
  }

  private loadCubeTexture(
    url: string,
    opts: LoadOptions,
    onProgress: (e: ProgressEvent) => void,
    _signal: AbortSignal,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const urls = Array.isArray(url) ? url : (opts.faces ?? url);
      this.#loaders.cubeTexture.load(urls, resolve, onProgress, reject);
    });
  }

  private loadRGBE(
    url: string,
    onProgress: (e: ProgressEvent) => void,
    _signal: AbortSignal,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      this.#loaders.rgbe.load(
        url,
        (tex: THREE.Texture) => {
          tex.mapping = THREE.EquirectangularReflectionMapping;
          resolve(tex);
        },
        onProgress,
        reject,
      );
    });
  }

  private async loadAudio(
    url: string,
    signal: AbortSignal,
  ): Promise<ArrayBuffer> {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} loading ${url}`);
    return res.arrayBuffer();
  }

  private async loadJSON(url: string, signal: AbortSignal): Promise<any> {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} loading ${url}`);
    return res.json();
  }

  private async loadBinary(
    url: string,
    signal: AbortSignal,
  ): Promise<ArrayBuffer> {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} loading ${url}`);
    return res.arrayBuffer();
  }

  // ─── Initialization ───────────────────────────────────────────────────────

  #initLoaders(): void {
    const manager = new THREE.LoadingManager();
    manager.onProgress = (url, loaded, total) =>
      this.emit("managerProgress", url, loaded, total);

    const draco = new DRACOLoader();
    draco.setDecoderPath(this.#opts.dracoPath);
    draco.preload();

    const gltf = new GLTFLoader(manager);
    gltf.setDRACOLoader(draco);

    if (this.#renderer) {
      const ktx2 = new KTX2Loader(manager);
      ktx2.setTranscoderPath(this.#opts.ktx2TranscoderPath);
      ktx2.detectSupport(this.#renderer);
      this.#loaders.ktx2 = ktx2;
    }

    this.#loaders.gltf = gltf;
    this.#loaders.texture = new THREE.TextureLoader(manager);
    this.#loaders.cubeTexture = new THREE.CubeTextureLoader(manager);
    this.#loaders.rgbe = new RGBELoader(manager);
  }

  private detectType(url: string): AssetType {
    const ext = url.split("?")[0].split(".").pop()?.toLowerCase();
    const map: Record<string, AssetType> = {
      glb: AssetType.GLTF,
      gltf: AssetType.GLTF,
      png: AssetType.TEXTURE,
      jpg: AssetType.TEXTURE,
      jpeg: AssetType.TEXTURE,
      webp: AssetType.TEXTURE,
      avif: AssetType.TEXTURE,
      ktx2: AssetType.TEXTURE,
      hdr: AssetType.RGBE,
      exr: AssetType.RGBE,
      mp3: AssetType.AUDIO,
      ogg: AssetType.AUDIO,
      wav: AssetType.AUDIO,
      json: AssetType.JSON,
      bin: AssetType.BINARY,
    };
    return map[ext ?? ""] ?? AssetType.BINARY;
  }
}

// ─── Factory Function ─────────────────────────────────────────────────────────

export function createAssetManager(
  options: Partial<DefaultOptions> = {},
  renderer: THREE.WebGLRenderer | null = null,
): AssetManager {
  return new AssetManager(options, renderer);
}

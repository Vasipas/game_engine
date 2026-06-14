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
  maxConcurrent: number; // Parallel downloads
  maxCacheSize: number; // MB in cache
  defaultTTL: number; // 5 min (ms), 0 = infinite
  maxRetries: number;
  retryDelay: number; // base retry delay (ms)
  dracoPath: string; // path to Draco decoder
  ktx2TranscoderPath: string; // path to KTX2 transcoder
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
  faces?: string | string[]; // For cube textures
}

type LoadItem = string | ({ url: string } & LoadOptions);

// ─── Helper Utilities ───────────────────────────────────────────────────────

/** Simple EventEmitter without dependencies */
class EventEmitter {
  #handlers = new Map<string, Set<(...args: any[]) => void>>();

  on(event: string, fn: (...args: any[]) => void): this {
    if (!this.#handlers.has(event)) {
      this.#handlers.set(event, new Set());
    }
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

/** Approximate resource size in bytes */
function estimateSize(asset: any, type: AssetType): number {
  if (!asset) return 0;
  switch (type) {
    case AssetType.TEXTURE: {
      const t = asset as THREE.Texture;
      if (!t.image) return 0;
      const { width = 0, height = 0 } = t.image;
      // RGBA * mips ≈ 4/3 factor
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
}

class LRUCache extends EventEmitter {
  #map = new Map<string, CacheEntry>(); // url → CacheEntry
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
    const entry: CacheEntry = {
      asset,
      type,
      bytes,
      expires,
      lastUsed: Date.now(),
    };

    this.#map.set(url, entry);
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

    // LRU: move to the end of the Map (most recently used)
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

  /** Explicit removal + GPU resource disposal */
  delete(url: string): void {
    if (this.#map.has(url)) {
      this.#evict(url, true);
    }
  }

  clear(dispose = true): void {
    for (const url of [...this.#map.keys()]) {
      this.#evict(url, dispose);
    }
  }

  /** Statistics */
  stats() {
    return {
      entries: this.#map.size,
      usedMB: +(this.#bytes / 1024 / 1024).toFixed(2),
      maxMB: +(this.#maxBytes / 1024 / 1024).toFixed(2),
      usagePercent: +((this.#bytes / this.#maxBytes) * 100).toFixed(1),
    };
  }

  // Private methods
  #evict(url: string, dispose = false): void {
    const entry = this.#map.get(url);
    if (!entry) return;
    this.#bytes -= entry.bytes;
    this.#map.delete(url);
    if (dispose) this.#dispose(entry.asset, entry.type);
    this.emit("evict", url, entry.asset);
  }

  #enforceBudget(): void {
    // Evict the oldest items until budget is recovered
    while (this.#bytes > this.#maxBytes && this.#map.size > 0) {
      const oldest = this.#map.keys().next().value;
      if (oldest !== undefined) this.#evict(oldest, true);
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
  #buckets: Array<Array<QueueTask>> = [[], [], [], []]; // Index matches Priority enum

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
  #inflight = new Map<string, Promise<any>>(); // url → Promise
  #active = 0;
  #opts: DefaultOptions;
  #loaders: {
    gltf: GLTFLoader;
    texture: THREE.TextureLoader;
    cubeTexture: THREE.CubeTextureLoader;
    rgbe: RGBELoader;
    ktx2?: KTX2Loader;
  } = {};
  #renderer: THREE.WebGLRenderer | null;
  #inflightControllers = new Map<string, AbortController>();
  #stats = { loaded: 0, failed: 0, cacheHits: 0 };

  /**
   * @param options Partial configuration overriding defaults
   * @param renderer Required for KTX2Loader support
   */
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

  /** Load a single resource */
  load(url: string, options: LoadOptions = {}): Promise<any> {
    return this.#scheduleLoad(url, options);
  }

  /** Load multiple resources in parallel (returns Map of url → asset) */
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

  /**
   * Preload resources in the background (non-blocking)
   * items = string[] | Array<{url, type, priority}>
   */
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

  /** Check if resource is in cache */
  isCached(url: string): boolean {
    return this.#cache.has(url);
  }

  /** Get from cache without loading */
  getFromCache(url: string): any {
    return this.#cache.get(url) ?? null;
  }

  /** Remove from cache (with disposal) */
  evict(url: string): void {
    this.#cache.delete(url);
  }

  /** Clear entire cache */
  clearCache(dispose = true): void {
    this.#cache.clear(dispose);
  }

  /** Cancel a pending load */
  cancel(url: string): void {
    this.#queue.remove((item) => item.url === url);
    const ctrl = this.#inflightControllers.get(url);
    ctrl?.abort();
    this.#inflightControllers.delete(url);
  }

  /** Get manager statistics */
  stats() {
    return {
      ...this.#stats,
      queue: this.#queue.size,
      active: this.#active,
      cache: this.#cache.stats(),
    };
  }

  /** Destroy the manager and clean up all resources */
  dispose(): void {
    this.#cache.clear(true);
    this.#inflight.clear();
    this.emit("dispose");
  }

  // ─── Private Methods ───────────────────────────────────────────────────────

  #scheduleLoad(url: string, opts: LoadOptions = {}): Promise<any> {
    // 1. Check Cache
    const cached = this.#cache.get(url);
    if (cached) {
      this.#stats.cacheHits++;
      this.emit("cacheHit", url);
      return Promise.resolve(cached);
    }

    // 2. Deduplicate inflight requests
    if (this.#inflight.has(url)) return this.#inflight.get(url);

    // 3. Queue the task
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

    // GLTF + Draco
    const draco = new DRACOLoader();
    draco.setDecoderPath(this.#opts.dracoPath);
    draco.preload();

    const gltf = new GLTFLoader(manager);
    gltf.setDRACOLoader(draco);

    // KTX2 (requires renderer)
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

// ─── Factory Function ───────────────────────────────────────────────────────

/** Creates a new AssetManager instance */
export function createAssetManager(
  options: Partial<DefaultOptions> = {},
  renderer: THREE.WebGLRenderer | null = null,
): AssetManager {
  return new AssetManager(options, renderer);
}

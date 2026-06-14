/**
 * AssetManager — производительный менеджер ресурсов для Three.js
 *
 * Возможности:
 *   - Параллельная загрузка с ограничением конкурентности
 *   - LRU-кэш с TTL и ограничением памяти
 *   - Дедупликация одновременных запросов (inflight)
 *   - Приоритеты загрузки (critical / high / normal / low)
 *   - Прогресс загрузки через EventEmitter
 *   - Автоматическое освобождение GPU-ресурсов (dispose)
 *   - Поддержка: GLB/GLTF, текстуры, аудио, JSON, кубические карты
 *   - Retry с экспоненциальным backoff
 *   - Tree-shaking: подключайте только нужные загрузчики
 */

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";

// ─── Константы ───────────────────────────────────────────────────────────────

const Priority = Object.freeze({ CRITICAL: 0, HIGH: 1, NORMAL: 2, LOW: 3 });

const AssetType = Object.freeze({
  GLTF: "gltf",
  TEXTURE: "texture",
  CUBE_TEXTURE: "cubeTexture",
  RGBE: "rgbe",
  AUDIO: "audio",
  JSON: "json",
  BINARY: "binary",
});

const DEFAULT_OPTIONS = {
  maxConcurrent: 6, // параллельных загрузок
  maxCacheSize: 512, // МБ в кэше
  defaultTTL: 300_000, // 5 мин (мс), 0 = бесконечно
  maxRetries: 3,
  retryDelay: 500, // базовая задержка retry (мс)
  dracoPath: "/draco/", // путь к Draco-декодеру
  ktx2TranscoderPath: "/basis/", // путь к KTX2-транскодеру
  textureEncoding: THREE.SRGBColorSpace,
  generateMipmaps: true,
  anisotropy: 4,
};

// ─── Вспомогательные утилиты ─────────────────────────────────────────────────

/** Простой EventEmitter без зависимостей */
class EventEmitter {
  #handlers = new Map();

  on(event, fn) {
    (
      this.#handlers.get(event) ??
      this.#handlers.set(event, new Set()).get(event)
    ).add(fn);
    return this;
  }
  off(event, fn) {
    this.#handlers.get(event)?.delete(fn);
    return this;
  }
  once(event, fn) {
    const wrapper = (...args) => {
      fn(...args);
      this.off(event, wrapper);
    };
    return this.on(event, wrapper);
  }
  emit(event, ...args) {
    this.#handlers.get(event)?.forEach((fn) => fn(...args));
  }
}

/** Приблизительный размер ресурса в байтах */
function estimateSize(asset, type) {
  if (!asset) return 0;
  switch (type) {
    case AssetType.TEXTURE: {
      const t = asset;
      if (!t.image) return 0;
      const { width = 0, height = 0 } = t.image;
      // RGBA * mips ≈ 4/3
      return width * height * 4 * (t.generateMipmaps ? 1.33 : 1);
    }
    case AssetType.GLTF: {
      let bytes = 0;
      asset.scene?.traverse((obj) => {
        obj.geometry?.attributes &&
          Object.values(obj.geometry.attributes).forEach((attr) => {
            bytes += attr.array?.byteLength ?? 0;
          });
        obj.geometry?.index &&
          (bytes += obj.geometry.index.array?.byteLength ?? 0);
      });
      return bytes;
    }
    default:
      return 0;
  }
}

// ─── LRU-кэш ─────────────────────────────────────────────────────────────────

class LRUCache extends EventEmitter {
  #map = new Map(); // url → CacheEntry
  #bytes = 0;
  #maxBytes;
  #defaultTTL;

  constructor(maxMB = 512, defaultTTL = 0) {
    super();
    this.#maxBytes = maxMB * 1024 * 1024;
    this.#defaultTTL = defaultTTL;
  }

  get size() {
    return this.#map.size;
  }
  get bytes() {
    return this.#bytes;
  }

  set(url: string, asset, type, ttl = this.#defaultTTL) {
    if (this.#map.has(url)) this.#evict(url);

    const bytes = estimateSize(asset, type);
    const expires = ttl > 0 ? Date.now() + ttl : Infinity;
    const entry = { asset, type, bytes, expires, lastUsed: Date.now() };

    this.#map.set(url, entry);
    this.#bytes += bytes;
    this.#enforceBudget();
    return this;
  }

  get(url: string) {
    const entry = this.#map.get(url);
    if (!entry) return null;

    if (Date.now() > entry.expires) {
      this.#evict(url);
      return null;
    }

    // LRU: переносим в конец
    entry.lastUsed = Date.now();
    this.#map.delete(url);
    this.#map.set(url, entry);
    return entry.asset;
  }

  has(url: string) {
    const entry = this.#map.get(url);
    if (!entry) return false;
    if (Date.now() > entry.expires) {
      this.#evict(url);
      return false;
    }
    return true;
  }

  /** Явное удаление + dispose GPU-ресурсов */
  delete(url: string) {
    if (this.#map.has(url)) {
      this.#evict(url, true);
    }
  }

  clear(dispose = true) {
    for (const url of [...this.#map.keys()]) this.#evict(url, dispose);
  }

  /** Статистика */
  stats() {
    return {
      entries: this.#map.size,
      usedMB: +(this.#bytes / 1024 / 1024).toFixed(2),
      maxMB: +(this.#maxBytes / 1024 / 1024).toFixed(2),
      usagePercent: +((this.#bytes / this.#maxBytes) * 100).toFixed(1),
    };
  }

  // ─── приватные ─────────────────────────────────────────────────────────────

  #evict(url: string, dispose = false) {
    const entry = this.#map.get(url);
    if (!entry) return;
    this.#bytes -= entry.bytes;
    this.#map.delete(url);
    if (dispose) this.#dispose(entry.asset, entry.type);
    this.emit("evict", url, entry.asset);
  }

  #enforceBudget() {
    // Выселяем наименее использованные пока бюджет не восстановится
    while (this.#bytes > this.#maxBytes && this.#map.size > 0) {
      const oldest = this.#map.keys().next().value;
      this.#evict(oldest, true);
    }
  }

  #dispose(asset, type: string) {
    if (!asset) return;
    try {
      switch (type) {
        case AssetType.TEXTURE:
        case AssetType.RGBE:
          asset.dispose?.();
          break;
        case AssetType.GLTF:
          asset.scene?.traverse((obj) => {
            obj.geometry?.dispose();
            if (obj.material) {
              const mats = Array.isArray(obj.material)
                ? obj.material
                : [obj.material];
              mats.forEach((m) => {
                Object.values(m).forEach((v) => v?.isTexture && v.dispose());
                m.dispose();
              });
            }
          });
          break;
        case AssetType.CUBE_TEXTURE:
          asset.dispose?.();
          break;
      }
    } catch (e) {
      console.warn("[AssetManager] dispose error:", e);
    }
  }
}

// ─── Очередь с приоритетами ───────────────────────────────────────────────────

class PriorityQueue {
  #buckets = [[], [], [], []]; // индекс = Priority

  enqueue(item, priority = Priority.NORMAL) {
    this.#buckets[priority].push(item);
  }

  dequeue() {
    for (const bucket of this.#buckets) {
      if (bucket.length) return bucket.shift();
    }
    return null;
  }

  get size() {
    return this.#buckets.reduce((s, b) => s + b.length, 0);
  }

  remove(predicate) {
    this.#buckets.forEach((b, i) => {
      this.#buckets[i] = b.filter((item) => !predicate(item));
    });
  }
}

// ─── Основной AssetManager ────────────────────────────────────────────────────

export class AssetManager extends EventEmitter {
  #cache;
  #queue = new PriorityQueue();
  #inflight = new Map(); // url → Promise
  #active = 0;
  #opts;
  #loaders = {};
  #renderer = null;
  #stats = { loaded: 0, failed: 0, cacheHits: 0 };

  /**
   * @param {Partial<typeof DEFAULT_OPTIONS>} options
   * @param {THREE.WebGLRenderer} [renderer] — нужен для KTX2Loader
   */
  constructor(options = {}, renderer = null) {
    super();
    this.#opts = { ...DEFAULT_OPTIONS, ...options };
    this.#renderer = renderer;
    this.#cache = new LRUCache(this.#opts.maxCacheSize, this.#opts.defaultTTL);
    this.#cache.on("evict", (url: string) => this.emit("evict", url));
    this.#initLoaders();
  }

  // ─── Публичное API ────────────────────────────────────────────────────────

  /** Загрузить один ресурс */
  load(url: string, options = {}) {
    return this.#scheduleLoad(url, options);
  }

  /** Загрузить несколько ресурсов параллельно (возвращает Map url→asset) */
  async loadAll(items) {
    const results = new Map();
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
   * Предзагрузка ресурсов в фоне (не блокирует)
   * items = string[] | Array<{url, type, priority}>
   */
  preload(items, defaultPriority = Priority.LOW) {
    items.forEach((item) => {
      const url = typeof item === "string" ? item : item.url;
      const opts =
        typeof item === "string"
          ? { priority: defaultPriority }
          : { priority: defaultPriority, ...item };
      if (!this.#cache.has(url) && !this.#inflight.has(url)) {
        this.#scheduleLoad(url, opts).catch(() => {});
      }
    });
  }

  /** Проверить наличие в кэше */
  isCached(url: string) {
    return this.#cache.has(url);
  }

  /** Получить из кэша без загрузки */
  getFromCache(url: string) {
    return this.#cache.get(url) ?? null;
  }

  /** Удалить из кэша (с dispose) */
  evict(url: string) {
    this.#cache.delete(url);
  }

  /** Очистить весь кэш */
  clearCache(dispose = true) {
    this.#cache.clear(dispose);
  }

  /** Отменить ожидающую загрузку */
  cancel(url: string) {
    this.#queue.remove((item) => item.url === url);
    // Если уже inflight — прерываем через AbortController
    const ctrl = this.#inflightControllers?.get(url);
    ctrl?.abort();
  }

  /** Статистика */
  stats() {
    return {
      ...this.#stats,
      queue: this.#queue.size,
      active: this.#active,
      cache: this.#cache.stats(),
    };
  }

  /** Уничтожить менеджер */
  dispose() {
    this.#cache.clear(true);
    this.#inflight.clear();
    this.emit("dispose");
  }

  // ─── Приватные методы ─────────────────────────────────────────────────────

  #inflightControllers = new Map();

  #scheduleLoad(url: string, opts = {}) {
    // 1. Кэш
    const cached = this.#cache.get(url);
    if (cached) {
      this.#stats.cacheHits++;
      this.emit("cacheHit", url);
      return Promise.resolve(cached);
    }

    // 2. Дедупликация inflight
    if (this.#inflight.has(url)) return this.#inflight.get(url);

    // 3. Очередь
    const priority = opts.priority ?? Priority.NORMAL;
    const promise = new Promise((resolve, reject) => {
      this.#queue.enqueue({ url, opts, resolve, reject }, priority);
    });

    this.#inflight.set(url, promise);
    promise.finally(() => this.#inflight.delete(url));
    this.#drain();
    return promise;
  }

  #drain() {
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

  async #execute(task) {
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
      } catch (err) {
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

  #loadAsset(url: string, opts, signal: AbortSignal) {
    const type = opts.type ?? this.detectType(url);
    const onProgress = (e) => {
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
        return Promise.reject(
          new Error(`[AssetManager] Unknown type for: ${url}`),
        );
    }
  }

  // ─── Загрузчики ──────────────────────────────────────────────────────────

  private loadGLTF(url: string, onProgress, _signal: AbortSignal) {
    return new Promise((resolve, reject) => {
      this.#loaders.gltf.load(url, resolve, onProgress, reject);
    });
  }

  private loadTexture(url: string, opts, onProgress, _signal: AbortSignal) {
    return new Promise((resolve, reject) => {
      const loader = url.endsWith(".ktx2")
        ? this.#loaders.ktx2
        : this.#loaders.texture;
      loader.load(
        url,
        (tex) => {
          tex.colorSpace = opts.colorSpace ?? this.#opts.textureEncoding;
          if (opts.generateMipmaps !== undefined)
            tex.generateMipmaps = opts.generateMipmaps;
          if (this.#opts.anisotropy) tex.anisotropy = this.#opts.anisotropy;
          if (opts.wrapS) tex.wrapS = opts.wrapS;
          if (opts.wrapT) tex.wrapT = opts.wrapT;
          tex.needsUpdate = true;
          resolve(tex);
        },
        onProgress,
        reject,
      );
    });
  }

  private loadCubeTexture(url: string, opts, onProgress, _signal: AbortSignal) {
    return new Promise((resolve, reject) => {
      // url — путь-шаблон или массив из 6 URL
      const urls = Array.isArray(url) ? url : (opts.faces ?? url);
      this.#loaders.cubeTexture.load(urls, resolve, onProgress, reject);
    });
  }

  private loadRGBE(url: string, onProgress, _signal: AbortSignal) {
    return new Promise((resolve, reject) => {
      this.#loaders.rgbe.load(
        url,
        (tex) => {
          tex.mapping = THREE.EquirectangularReflectionMapping;
          resolve(tex);
        },
        onProgress,
        reject,
      );
    });
  }

  private async loadAudio(url: string, signal: AbortSignal) {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} loading ${url}`);
    return res.arrayBuffer();
  }

  private async loadJSON(url: string, signal: AbortSignal) {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} loading ${url}`);
    return res.json();
  }

  private async loadBinary(url: string, signal: AbortSignal) {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} loading ${url}`);
    return res.arrayBuffer();
  }

  // ─── Инициализация загрузчиков ────────────────────────────────────────────

  #initLoaders() {
    const manager = new THREE.LoadingManager();
    manager.onProgress = (url, loaded, total) =>
      this.emit("managerProgress", url, loaded, total);

    // GLTF + Draco
    const draco = new DRACOLoader();
    draco.setDecoderPath(this.#opts.dracoPath);
    draco.preload();

    const gltf = new GLTFLoader(manager);
    gltf.setDRACOLoader(draco);

    // KTX2 (нужен renderer)
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

  // ─── Определение типа по расширению ──────────────────────────────────────

  private detectType(url: any) {
    const ext = url.split("?")[0].split(".").pop().toLowerCase();
    const map = {
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
    return map[ext] ?? AssetType.BINARY;
  }
}

// ─── Экспорт вспомогательных констант ────────────────────────────────────────

export { Priority, AssetType };

// ─── Фабричная функция ────────────────────────────────────────────────────────

export function createAssetManager(options = {}, renderer = null) {
  return new AssetManager(options, renderer);
}

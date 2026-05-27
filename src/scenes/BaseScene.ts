import * as THREE from "three";
import type { SceneContext } from "../types/scene";

const $initialized = Symbol("initialized");
const $loaded = Symbol("loaded");

export abstract class BaseScene {
  public readonly scene: THREE.Scene;
  public readonly camera: THREE.PerspectiveCamera;

  protected context!: SceneContext;

  private [$initialized] = false;
  private [$loaded] = false;

  constructor() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x7c3aed);

    this.camera = new THREE.PerspectiveCamera(
      75,
      window.innerWidth / window.innerHeight,
      0.1,
      1000,
    );
  }

  // Public lifecycle hooks (overridden in subclasses)

  /** Called once on first activation — synchronous initialization */
  protected init(): void {}

  /** Called once on first activation — async resource loading (textures, GLTF, etc.) */
  protected async load(): Promise<void> {}

  /** Called on every deactivation — GPU resource cleanup */
  protected unload(): void {}

  /** Called every time the scene is entered */
  protected enter(): void {}

  /** Called every time the scene is exited */
  protected exit(): void {}

  /** Called every frame */
  abstract update(delta: number, elapsed: number): void;

  /** Full cleanup on destruction (called only from Engine.dispose) */
  abstract dispose(): void;

  // Internal lifecycle control (called only from SceneManager)
  // Using external control via WeakMap in SceneManager — these methods are here for convenience

  /** @internal */
  async _initOnce(): Promise<void> {
    if (this[$initialized]) return;
    this[$initialized] = true;
    this.init();
  }

  /** @internal */
  async _loadOnce(): Promise<void> {
    if (this[$loaded]) return;
    this[$loaded] = true;
    await this.load();
  }

  /** @internal */
  _unload(): void {
    if (!this[$loaded]) return;
    this[$loaded] = false;
    this.unload();
  }

  /** @internal */
  _enter(): void {
    this.enter();
  }

  /** @internal */
  _exit(): void {
    this.exit();
  }

  /** @internal — called from SceneManager when resizing active scene */
  onResize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /** @internal */
  setContext(ctx: SceneContext): void {
    this.context = ctx;
  }
}

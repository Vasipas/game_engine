import type { BaseScene } from "../scenes/BaseScene";
import type { TSceneKeys } from "../types/scene";
import type { EngineContext } from "./Engine";
import { InputManager } from "./InputManager";

export type SceneContext = {
  input: InputManager;
  switchScene: (key: TSceneKeys) => Promise<void>;
  getScene: <T extends BaseScene>(key: TSceneKeys) => T | undefined;
};

export type SceneChangeCallback = (
  prev: TSceneKeys | null,
  next: TSceneKeys,
) => void;

export class SceneManager {
  private scenes = new Map<TSceneKeys, BaseScene>();
  private activeScene: BaseScene | null = null;
  private activeKey: TSceneKeys | null = null;
  private changeListeners: SceneChangeCallback[] = [];
  private isSwitching = false;

  constructor(private context: EngineContext) {}

  private createContext(): SceneContext {
    return {
      input: this.context.input,
      switchScene: (key) => this.setActive(key),
      getScene: <T extends BaseScene>(key: TSceneKeys) =>
        this.scenes.get(key) as T | undefined,
    };
  }

  register(key: TSceneKeys, scene: BaseScene): this {
    if (this.scenes.has(key)) {
      console.warn(
        `[SceneManager] Scene "${key}" already registered, rewriting`,
      );
    }
    scene.setContext(this.createContext());
    this.scenes.set(key, scene);
    return this; // fluent API: manager.register('GAME', ...).register('MENU', ...)
  }

  async setActive(key: TSceneKeys): Promise<void> {
    if (this.isSwitching) {
      console.warn(
        `[SceneManager] Switching in process, ignored request on "${key}"`,
      );
      return;
    }

    if (this.activeKey === key) return;

    const next = this.scenes.get(key);
    if (!next) {
      console.error(`[SceneManager] Scene "${key}" not found`);
      return;
    }

    this.isSwitching = true;
    const prevKey = this.activeKey;

    try {
      // 1. EXIT
      if (this.activeScene) {
        this.activeScene._exit();
        this.activeScene._unload();
      }
      this.activeScene = next;
      this.activeKey = key;

      // INIT ONCE
      await next._initOnce();

      // LOAD ONCE — async GPU sources load (textures, models)
      await next._loadOnce();

      // 5. ENTER
      next._enter();

      // 6. CHANGE LISTENERS
      this.changeListeners.forEach((cb) => cb(prevKey, key));
    } finally {
      this.isSwitching = false;
    }
  }

  update(delta: number, elapsed: number): void {
    this.activeScene?.update(delta, elapsed);
  }

  onResize(width: number, height: number): void {
    this.activeScene?.onResize(width, height);
  }

  onSceneChange(cb: SceneChangeCallback): () => void {
    this.changeListeners.push(cb);

    return () => {
      this.changeListeners = this.changeListeners.filter((l) => l !== cb);
    };
  }

  getActiveKey(): TSceneKeys | null {
    return this.activeKey;
  }

  getActiveScene(): BaseScene | null {
    return this.activeScene;
  }

  dispose(): void {
    if (this.activeScene) {
      this.activeScene._exit();
    }

    this.scenes.forEach((scene) => {
      scene._unload();
      scene.dispose();
    });

    this.scenes.clear();
    this.activeScene = null;
    this.activeKey = null;
    this.changeListeners = [];
  }
}

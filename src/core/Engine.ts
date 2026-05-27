import * as THREE from "three";
import { SceneManager } from "./SceneManager";
import type { TSceneKeys } from "../types/scene";
import type { BaseScene } from "../scenes/BaseScene";
import { InputManager } from "./InputManager";

export interface EngineOptions {
  initialScene: TSceneKeys;
  antialias?: boolean;
  maxPixelRatio?: number;
}

export interface EngineContext {
  renderer: THREE.WebGLRenderer;
  input: InputManager;
}

export class Engine {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly clock: THREE.Clock;
  private readonly sceneManager: SceneManager;
  private readonly options: EngineOptions;
  private readonly input: InputManager;
  private animationId = 0;
  private isRunning = false;

  constructor(
    canvas: HTMLCanvasElement,
    scenes: Partial<Record<TSceneKeys, BaseScene>>,
    options: EngineOptions,
  ) {
    this.clock = new THREE.Clock();
    this.options = options;
    this.input = new InputManager();

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: options.antialias ?? true,
      powerPreference: "high-performance",
    });

    const maxDPR = options.maxPixelRatio ?? 2;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxDPR));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;

    const context: EngineContext = {
      renderer: this.renderer,
      input: this.input,
    };

    this.sceneManager = new SceneManager(context);

    Object.entries(scenes).forEach(([key, scene]) => {
      if (scene) this.sceneManager.register(key as TSceneKeys, scene);
    });

    window.addEventListener("resize", this.onResize);
  }

  async start(): Promise<void> {
    if (this.isRunning) return;

    await this.sceneManager.setActive(this.options.initialScene);

    this.isRunning = true;
    this.clock.start();
    this.loop();
  }

  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    this.clock.stop();
    cancelAnimationFrame(this.animationId);
  }

  async switchScene(key: TSceneKeys): Promise<void> {
    await this.sceneManager.setActive(key);
  }

  getSceneManager(): SceneManager {
    return this.sceneManager;
  }

  private loop = (): void => {
    if (!this.isRunning) return;
    this.animationId = requestAnimationFrame(this.loop);

    const delta = this.clock.getDelta();
    const elapsed = this.clock.getElapsedTime();

    this.sceneManager.update(delta, elapsed);

    const active = this.sceneManager.getActiveScene();
    if (active) {
      this.renderer.render(active.scene, active.camera);
    }
  };

  private onResize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;

    this.renderer.setSize(w, h);
    this.sceneManager.onResize(w, h);
  };

  dispose(): void {
    this.stop();
    window.removeEventListener("resize", this.onResize);
    this.sceneManager.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

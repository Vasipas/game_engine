import * as THREE from "three";
import { BaseScene } from "./BaseScene";
import { SystemManager } from "../core/SystemManager";
import { World } from "../ecs/World";
import { MovementSystem } from "../ecs/systems/MovementSystem";
import { RenderSyncSystem } from "../ecs/systems/RenderSyncSystem";
import { PlayerFactory } from "../ecs/entities/PlayerFactory";
import { FloorFactory } from "../ecs/entities/FloorFactory";

export class GameScene extends BaseScene {
  private world = new World();
  private systems = new SystemManager();

  init() {
    this.camera.position.set(0, 3, 8);
    this.setupLights();

    FloorFactory.create(this.scene);
    PlayerFactory.create(this.world, this.scene);

    this.systems.add(new MovementSystem(this.world, this.context.input));
    this.systems.add(new RenderSyncSystem(this.world));
  }

  private setupLights() {
    // AmbientLight
    const ambient = new THREE.AmbientLight(0xffffff, 0.4);
    this.scene.add(ambient);

    // DirectionalLight
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
    dirLight.position.set(10, 15, 10);
    dirLight.castShadow = true;

    dirLight.shadow.mapSize.set(2048, 2048);
    dirLight.shadow.camera.near = 0.5;
    dirLight.shadow.camera.far = 50;
    this.scene.add(dirLight);
  }

  update(delta: number, elapsed: number) {
    this.systems.update(delta, elapsed);
  }

  dispose() {
    this.scene.traverse((obj: any) => {
      if (obj.geometry) obj.geometry.dispose?.();

      if (obj.material) {
        if (Array.isArray(obj.material)) {
          obj.material.forEach((m: THREE.Material) => m.dispose?.());
        } else {
          obj.material.dispose?.();
        }
      }
    });
    this.systems.clear();
  }
}

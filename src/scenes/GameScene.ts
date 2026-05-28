import * as THREE from "three";
import { BaseScene } from "./BaseScene";
import { SystemManager } from "../core/SystemManager";
import { World } from "../ecs/World";
import { MovementSystem } from "../ecs/systems/MovementSystem";
import { RenderSyncSystem } from "../ecs/systems/RenderSyncSystem";
import { PlayerFactory } from "../ecs/entities/PlayerFactory";
import { FloorFactory } from "../ecs/entities/FloorFactory";
import { CameraFollowSystem } from "../ecs/systems/CameraFolowSystem";
import { DirectionalLightFactory } from "../ecs/entities/DirectionalLightFactory";
import { AmbientLightFactory } from "../ecs/entities/AmbientLightFactory";
import { PerspectiveCameraFactory } from "../ecs/entities/PerspectiveCameraFactory";

export class GameScene extends BaseScene {
  private world = new World();
  private systems = new SystemManager();

  init() {
    const player = PlayerFactory.create(this.world, this.scene);
    this.camera = new THREE.PerspectiveCamera(
      75,
      window.innerWidth / window.innerHeight,
      0.1,
      1000,
    );

    PerspectiveCameraFactory.create(this.world, this.camera, player);
    AmbientLightFactory.create(this.scene);
    DirectionalLightFactory.create(this.scene);
    FloorFactory.create(this.scene);

    this.systems.add(new MovementSystem(this.world, this.context.input));
    this.systems.add(new CameraFollowSystem(this.world));
    this.systems.add(new RenderSyncSystem(this.world));
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

import { CameraFollowComponent } from "../components/CameraFollowComponent";
import * as THREE from "three";
import type { World } from "../World";

export class PerspectiveCameraFactory {
  static create(world: World, camera: THREE.Camera, target: number) {
    const cameraEntity = world.addEntity();
    world.addComponent(
      cameraEntity,
      new CameraFollowComponent(camera, target, new THREE.Vector3(0, 4, 8), 20),
    );
    return camera;
  }
}

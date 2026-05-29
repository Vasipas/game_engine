import { CameraFollowComponent } from "../components/CameraFollowComponent";
import * as THREE from "three";
import type { World } from "../World";
import { MouseLookComponent } from "../components/MouseLookComponent";

type TOptions = {
  lookAtTarget?: boolean;
  position: THREE.Vector3;
  smoothing: number;
  distance: number;
};

export class PerspectiveCameraFactory {
  static create(
    world: World,
    camera: THREE.Camera,
    target: number,
    options: TOptions,
  ) {
    const cameraEntity = world.addEntity();
    world.addComponent(
      cameraEntity,
      new CameraFollowComponent(
        camera,
        target,
        options.position,
        options.smoothing,
        options.distance,
      ),
    );
    if (options?.lookAtTarget) {
      world.addComponent(cameraEntity, new MouseLookComponent());
    }
    return cameraEntity;
  }
}

import { CameraFollowComponent } from "../components/CameraFollowComponent";
import { PositionComponent } from "../components/PositionComponent";
import type { World } from "../World";
import * as THREE from "three";

export class CameraFollowSystem {
  public priority = 2;

  private _tmpPosition = new THREE.Vector3();
  private offset = new THREE.Vector3(0, 5, 10);

  private firstUpdate = true;

  constructor(
    private world: World,
    private camera: THREE.Camera,
  ) {}

  update(delta: number) {
    const follows = this.world.query(CameraFollowComponent, PositionComponent);

    for (const entity of follows) {
      const position = this.world.getComponent(entity, PositionComponent);
      const follow = this.world.getComponent(entity, CameraFollowComponent);

      if (!position || !follow) continue;

      this._tmpPosition.copy(position).add(this.offset);

      if (this.firstUpdate) {
        this.camera.position.copy(this._tmpPosition);
        this.firstUpdate = false;
      } else {
        const alpha = 1 - Math.exp(-follow.smoothing * delta);

        this.camera.position.lerp(this._tmpPosition, alpha);
      }

      this.camera.lookAt(position.x, position.y, position.z);
    }
  }
}

import { CameraFollowComponent } from "../components/CameraFollowComponent";
import { PositionComponent } from "../components/PositionComponent";
import type { World } from "../World";
import * as THREE from "three";

export class CameraFollowSystem {
  public priority = 2;

  private _tmpPosition = new THREE.Vector3();
  private offset = new THREE.Vector3(0, 5, 10);

  private firstUpdate = true;

  constructor(private world: World) {}

  update(delta: number) {
    const follows = this.world.query(CameraFollowComponent);

    for (const entity of follows) {
      const follow = this.world.getComponent(entity, CameraFollowComponent);

      if (follow.target === null) continue;

      const position = this.world.getComponent(
        follow.target,
        PositionComponent,
      );

      if (!position || !follow) continue;

      this._tmpPosition.copy(position).add(this.offset);

      if (this.firstUpdate) {
        follow.camera.position.copy(this._tmpPosition);
        this.firstUpdate = false;
      } else {
        const alpha = 1 - Math.exp(-follow.smoothing * delta);
        follow.camera.position.lerp(this._tmpPosition, alpha);
      }

      follow.camera.lookAt(position.x, position.y, position.z);
    }
  }
}

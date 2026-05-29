import { CameraFollowComponent } from "../components/CameraFollowComponent";
import { MouseLookComponent } from "../components/MouseLookComponent";
import { PositionComponent } from "../components/PositionComponent";
import type { World } from "../World";
import * as THREE from "three";

export class CameraFollowSystem {
  public priority = 2;

  private _tmpPosition = new THREE.Vector3();
  private _direction = new THREE.Vector3();

  private firstUpdate = true;

  constructor(private world: World) {}

  update(delta: number) {
    const follows = this.world.query(CameraFollowComponent);

    for (const entity of follows) {
      const follow = this.world.getComponent(entity, CameraFollowComponent);
      const look = this.world.getComponent(entity, MouseLookComponent);

      if (follow.target === null) continue;

      const position = this.world.getComponent(
        follow.target,
        PositionComponent,
      );

      if (!position) continue;

      if (look) {
        this._direction.set(
          Math.cos(look.pitch) * Math.sin(look.yaw),
          Math.sin(look.pitch),
          Math.cos(look.pitch) * Math.cos(look.yaw),
        );
      } else {
        this._direction.set(0, 0, 4);
      }

      const distance = THREE.MathUtils.clamp(
        follow.distance,
        follow.minDistance ?? 2,
        follow.maxDistance ?? 10,
      );

      this._direction.multiplyScalar(distance);
      this._tmpPosition.copy(position).sub(this._direction);
      this._tmpPosition.y += follow.height ?? 0;

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

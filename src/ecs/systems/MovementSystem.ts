import type { InputManager } from "../../core/InputManager";
import { CameraFollowComponent } from "../components/CameraFollowComponent";
import { PlayerTagComponent } from "../components/PlayerTagComponent";
import { PositionComponent } from "../components/PositionComponent";
import { RotateComponent } from "../components/RotateComponent";
import { VelocityComponent } from "../components/VelocityComponent";
import type { World } from "../World";
import * as THREE from "three";

export class MovementSystem {
  public priority = 1;
  private forward = new THREE.Vector3();
  private right = new THREE.Vector3();
  private move = new THREE.Vector3();
  private direction = new THREE.Vector3();

  constructor(
    private world: World,
    private input: InputManager,
  ) {}

  update(delta: number) {
    const speed = 5;

    const movingItems = this.world.query(
      VelocityComponent,
      PositionComponent,
      RotateComponent,
    );
    const cameraEntities = this.world.query(CameraFollowComponent);

    const camera = this.world.getComponent(
      cameraEntities[0],
      CameraFollowComponent,
    );

    camera.camera.getWorldDirection(this.forward);
    this.forward.y = 0;
    this.forward.normalize();

    this.right
      .crossVectors(this.forward, new THREE.Vector3(0, 1, 0))
      .normalize();

    for (const entity of movingItems) {
      const position = this.world.getComponent(entity, PositionComponent);
      const velocity = this.world.getComponent(entity, VelocityComponent);
      const rotation = this.world.getComponent(entity, RotateComponent);
      const playerTag = this.world.getComponent(entity, PlayerTagComponent);

      if (!position) continue;

      velocity.x = 0;
      velocity.z = 0;

      let x = 0;
      let z = 0;

      if (playerTag.isPlayer) {
        if (this.input.isDown("KeyW")) z += 1;
        if (this.input.isDown("KeyS")) z -= 1;
        if (this.input.isDown("KeyA")) x -= 1;
        if (this.input.isDown("KeyD")) x += 1;
      }

      this.move.set(0, 0, 0);
      this.move.addScaledVector(this.forward, z);
      this.move.addScaledVector(this.right, x);

      const len = this.move.length();

      if (len > 0) {
        this.move.normalize();
      }

      velocity.x = this.move.x;
      velocity.z = this.move.z;

      this.direction.copy(velocity);
      this.direction.y = 0;

      if (this.direction.lengthSq() < 0.0001) continue;

      this.direction.normalize();
      const yaw = Math.atan2(this.direction.x, this.direction.z);
      rotation.y = THREE.MathUtils.damp(rotation.y, yaw, 10, delta);

      position.x += velocity.x * speed * delta;
      position.z += velocity.z * speed * delta;
    }
  }
}

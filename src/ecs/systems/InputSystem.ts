import type { InputManager } from "../../core/InputManager";
import { CameraFollowComponent } from "../components/CameraFollowComponent";
import { PlayerTagComponent } from "../components/PlayerTagComponent";
import { RotateComponent } from "../components/RotateComponent";
import { VelocityComponent } from "../components/VelocityComponent";
import type { World } from "../World";
import * as THREE from "three";

export class InputSustem {
  priority = 1;
  public speed = 10;
  private forward = new THREE.Vector3();
  private right = new THREE.Vector3();
  private move = new THREE.Vector3();
  private direction = new THREE.Vector3();
  private static up = new THREE.Vector3(0, 1, 0);

  constructor(
    private world: World,
    private input: InputManager,
  ) {}
  update(delta: number) {
    const players = this.world.query(PlayerTagComponent);
    const cameraEntities = this.world.query(CameraFollowComponent);

    const camera = this.world.getComponent(
      cameraEntities[0],
      CameraFollowComponent,
    );

    camera.camera.getWorldDirection(this.forward);
    this.forward.y = 0;
    this.forward.normalize();

    this.right.crossVectors(this.forward, InputSustem.up).normalize();

    for (const entity of players) {
      const velocity = this.world.getComponent(entity, VelocityComponent);
      const rotation = this.world.getComponent(entity, RotateComponent);

      velocity.x = 0;
      velocity.z = 0;
      velocity.y = 0;

      let x = 0;
      let z = 0;

      if (entity !== null) {
        if (this.input.isDown("KeyW")) z += this.speed;
        if (this.input.isDown("KeyS")) z -= this.speed;
        if (this.input.isDown("KeyA")) x -= this.speed;
        if (this.input.isDown("KeyD")) x += this.speed;
      }

      this.move.set(0, 0, 0);
      this.move.addScaledVector(this.forward, z);
      this.move.addScaledVector(this.right, x);

      if (this.move.lengthSq() > 0) {
        this.move.normalize();
      }

      velocity.x = this.move.x;
      velocity.z = this.move.z;

      this.direction.copy(velocity);
      this.direction.y = 0;

      if (this.direction.lengthSq() < 0.0001) continue;

      this.direction.normalize();
      const yaw = Math.atan2(this.direction.x, this.direction.z);
      const angle =
        THREE.MathUtils.euclideanModulo(
          yaw - rotation.y + Math.PI,

          Math.PI * 2,
        ) - Math.PI;

      rotation.y += angle * (1 - Math.exp(-10 * delta));
    }
  }
}

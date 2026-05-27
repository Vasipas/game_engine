import type { InputManager } from "../../core/InputManager";
import { PositionComponent } from "../components/PositionComponent";
import { VelocityComponent } from "../components/VelocityComponent";
import type { World } from "../World";

export class MovementSystem {
  public priority = 1;
  constructor(
    private world: World,
    private input: InputManager,
  ) {}

  update(delta: number) {
    const speed = 5;

    const movingItems = this.world.query(VelocityComponent, PositionComponent);

    for (const entity of movingItems) {
      const position = this.world.getComponent(entity, PositionComponent);
      const velocity = this.world.getComponent(entity, VelocityComponent);
      if (!position) continue;

      velocity.x = 0;
      velocity.z = 0;

      if (this.input.isDown("KeyW")) velocity.z -= 1;
      if (this.input.isDown("KeyS")) velocity.z += 1;
      if (this.input.isDown("KeyA")) velocity.x -= 1;
      if (this.input.isDown("KeyD")) velocity.x += 1;

      const len = Math.hypot(velocity.x, velocity.z);
      if (len > 0) {
        velocity.x /= len;
        velocity.z /= len;
      }

      position.x += velocity.x * speed * delta;
      position.z += velocity.z * speed * delta;
    }
  }
}

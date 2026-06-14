import { PositionComponent } from "../components/PositionComponent";
import { RotateComponent } from "../components/RotateComponent";
import { VelocityComponent } from "../components/VelocityComponent";
import type { World } from "../World";
export class MovementSystem {
  public priority = 2;

  constructor(private world: World) {}

  update(delta: number) {
    const movingItems = this.world.query(
      VelocityComponent,
      PositionComponent,
      RotateComponent,
    );

    for (const entity of movingItems) {
      const position = this.world.getComponent(entity, PositionComponent);
      const velocity = this.world.getComponent(entity, VelocityComponent);

      position.x += velocity.x * delta;
      position.z += velocity.z * delta;
      position.y += velocity.y * delta;
    }
  }
}

import { MeshComponent } from "../components/MeshComponent";
import { PositionComponent } from "../components/PositionComponent";
import { RotateComponent } from "../components/RotateComponent";
import type { World } from "../World";

export class RenderSyncSystem {
  public priority = 3;
  constructor(private world: World) {}

  update(delta: number) {
    const meshEntities = this.world.query(
      MeshComponent,
      PositionComponent,
      RotateComponent,
    );

    for (const entity of meshEntities) {
      const position = this.world.getComponent(entity, PositionComponent);
      const mesh = this.world.getComponent(entity, MeshComponent);
      const rotation = this.world.getComponent(entity, RotateComponent);

      mesh.mesh.rotation.set(rotation.x, rotation.y, rotation.z);
      mesh.mesh.position.set(position.x, position.y, position.z);
    }
  }
}

import { MeshComponent } from "../components/MeshComponent";
import { PositionComponent } from "../components/PositionComponent";
import type { World } from "../World";

export class RenderSyncSystem {
  public priority = 3;
  constructor(private world: World) {}

  update(delta: number) {
    const meshEntities = this.world.query(MeshComponent, PositionComponent);

    for (const entity of meshEntities) {
      const position = this.world.getComponent(entity, PositionComponent);
      const mesh = this.world.getComponent(entity, MeshComponent);
      mesh.mesh.position.set(position.x, position.y, position.z);
    }
  }
}

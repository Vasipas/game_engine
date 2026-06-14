import type { InputManager } from "../../core/InputManager";
import { MouseLookComponent } from "../components/MouseLookComponent";
import type { World } from "../World";

export class MouseMoveSystem {
  public priority = 3;
  constructor(
    private world: World,
    private input: InputManager,
  ) {}

  update(delta: number) {
    const cameras = this.world.query(MouseLookComponent);
    const { dx, dy } = this.input.consumeMouseDelta();

    for (const camera of cameras) {
      const look = this.world.getComponent(camera, MouseLookComponent);

      look.yaw -= dx * look.sensitivity;
      look.pitch -= dy * look.sensitivity;
      look.pitch = Math.max(-1.5, Math.min(1, look.pitch));
    }
  }
}

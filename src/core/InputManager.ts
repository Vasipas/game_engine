export class InputManager {
  keys = new Set<string>();
  mouseDeltaX = 0;
  mouseDeltaY = 0;
  pointerLocked = false;

  constructor() {
    window.addEventListener("keydown", (e) => this.keys.add(e.code));
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    const canvas = document.querySelector("canvas");
    canvas?.addEventListener("click", () => {
      canvas.requestPointerLock();
    });
    document.addEventListener("mousemove", (e) => {
      if (document.pointerLockElement === canvas) {
        this.mouseDeltaX += e.movementX;
        this.mouseDeltaY += e.movementY;
      }
    });
  }

  public consumeMouseDelta() {
    const dx = this.mouseDeltaX;
    const dy = this.mouseDeltaY;

    return { dx, dy };
  }

  public clearDelta() {
    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
  }

  isDown(code: string) {
    return this.keys.has(code);
  }
}

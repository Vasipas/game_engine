export class InputManager {
  keys = new Set<string>();

  constructor() {
    window.addEventListener("keydown", (e) => this.keys.add(e.code));
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
  }

  isDown(code: string) {
    return this.keys.has(code);
  }
}

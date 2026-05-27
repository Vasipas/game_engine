interface ISystem {
  priority: number;
  update: (delta: number, elapsed?: number) => any;
}

export class SystemManager {
  private systems: ISystem[] = [];

  add(system: ISystem) {
    this.systems.push(system);
    this.systems.sort((a, b) => a.priority - b.priority);
  }
  update(delta: number, elapsed: number) {
    for (const system of this.systems) {
      system.update(delta, elapsed);
    }
  }
  remove(system: ISystem) {
    this.systems = this.systems.filter((s) => s !== system);
  }
  clear() {
    this.systems.length = 0;
  }
}

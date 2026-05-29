export class World {
  private nextEntityId = 0;
  private components = new Map<Function, Map<number, any>>();

  addEntity(): number {
    return this.nextEntityId++;
  }
  addComponent<T>(entity: number, component: T) {
    const type = component!.constructor;

    if (!this.components.has(type)) {
      this.components.set(type, new Map());
    }

    this.components.get(type)?.set(entity, component);
  }
  getComponent<T>(entity: number, componenClass: new (...args: any[]) => T): T {
    return this.components.get(componenClass)?.get(entity);
  }

  hasComponent(entity: number, componentClass: Function): boolean {
    return this.components.get(componentClass)?.has(entity) ?? false;
  }
  query(...componenClasses: Function[]): number[] {
    if (!componenClasses.length) return [];
    const firstStore = this.components.get(componenClasses[0]);

    if (!firstStore) return [];

    const entities: number[] = [];

    for (const entity of firstStore.keys()) {
      const matches = componenClasses.every((cl) =>
        this.hasComponent(entity, cl),
      );

      if (matches) {
        entities.push(entity);
      }
    }
    return entities;
  }
}
